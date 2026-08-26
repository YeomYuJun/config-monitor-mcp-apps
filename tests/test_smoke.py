#!/usr/bin/env python3
r"""
test_smoke.py - cas.py / claude_config.py / config_edit.py 스모크 테스트.

의존성 0: 표준 unittest 로 작성(pytest 로도 실행됨).
  python -m unittest tests.test_smoke -v      (프로젝트 루트에서)
  python -m pytest tests/test_smoke.py         (pytest 있으면)

다음 회귀를 가드한다:
  - claude_config dump 가 cp949 콘솔에서 UnicodeEncodeError 로 죽지 않는다.
  - cas watcher-status 가 PS 의 BOM + tz-aware heartbeat 를 견딘다.
"""
import json, os, subprocess, sys, tempfile, time, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(os.path.dirname(HERE), "src")
CAS = os.path.join(SRC, "cas.py")
CFG = os.path.join(SRC, "claude_config.py")
EDIT = os.path.join(SRC, "config_edit.py")
LIB = os.path.join(SRC, "library.py")


def run(script, *args, env=None):
    """스크립트를 서브프로세스로 실행. (returncode, stdout, stderr) 반환.
    CLAUDE_CAS_NO_DEFAULT_TRACK=1: 테스트 store 에 실사용자 설정파일이
    자동 병합(DEFAULT_TRACKED)되지 않게 격리."""
    e = dict(os.environ)
    e["CLAUDE_CAS_NO_DEFAULT_TRACK"] = "1"
    if env:
        e.update(env)
    p = subprocess.run([sys.executable, script, *args], capture_output=True, text=True,
                       encoding="utf-8", env=e, timeout=60)
    return p.returncode, p.stdout, p.stderr


class CasRoundTrip(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="cas_test_")
        self.store = os.path.join(self.tmp, "store")
        self.target = os.path.join(self.tmp, "target.txt")
        with open(self.target, "w", encoding="utf-8") as f:
            f.write("v1 line A\nv1 line B\n")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def cas(self, *args):
        return run(CAS, "--store", self.store, *args)

    def _lock_path(self):
        return os.path.join(self.store, "snapshot.lock")

    def test_snapshot_refuses_while_another_holds_the_lock(self):
        # 편집(config_edit)과 watcher 는 항상 겹쳐 돈다. 겹친 쪽이 index/parent 를 같이 읽으면
        # 이력 체인이 갈라지므로, 락을 못 잡으면 스냅샷을 만들지 않고 물러나야 한다.
        self.cas("init")
        self.cas("track", self.target)
        with open(self._lock_path(), "w", encoding="utf-8") as f:
            f.write('{"pid": 1}')
        rc, out, err = run(CAS, "--store", self.store, "snapshot", "-m", "blocked",
                           env={"CLAUDE_CAS_LOCK_WAIT": "0.3"})
        self.assertEqual(rc, 1, out)
        self.assertIn("진행 중", out)
        self.assertEqual(os.listdir(os.path.join(self.store, "snapshots")), [])

    def test_stale_lock_is_broken(self):
        # 죽은 프로세스가 남긴 락에 영구히 막히면 안 된다. 판정은 pid 가 아니라 나이로 한다.
        self.cas("init")
        self.cas("track", self.target)
        lock = self._lock_path()
        with open(lock, "w", encoding="utf-8") as f:
            f.write('{"pid": 1}')
        old = time.time() - 3600            # LOCK_STALE_SEC(60s) 를 넉넉히 넘긴 나이
        os.utime(lock, (old, old))
        rc, out, err = run(CAS, "--store", self.store, "snapshot", "-m", "after stale",
                           env={"CLAUDE_CAS_LOCK_WAIT": "0.3"})
        self.assertEqual(rc, 0, err)
        self.assertFalse(os.path.exists(lock))

    def test_full_flow(self):
        rc, out, err = self.cas("init")
        self.assertEqual(rc, 0, err)
        rc, out, err = self.cas("track", self.target)
        self.assertEqual(rc, 0, err)

        rc, out, err = self.cas("snapshot", "-m", "baseline")
        self.assertEqual(rc, 0, err)
        sid = next(tok for tok in out.split() if tok[:8].isdigit() and "T" in tok)

        # status --json 는 순수 JSON 한 줄
        rc, out, err = self.cas("status", "--json")
        self.assertEqual(rc, 0, err)
        st = json.loads(out)
        self.assertIn(self.target, st["unchanged"])

        # 수정 후 modified 감지
        with open(self.target, "w", encoding="utf-8") as f:
            f.write("v2 CHANGED\nv1 line B\n")
        rc, out, _ = self.cas("status", "--json")
        self.assertIn(self.target, json.loads(out)["modified"])

        # diff 텍스트
        rc, out, err = self.cas("diff", self.target, "--from", sid)
        self.assertEqual(rc, 0, err)
        self.assertIn("v2 CHANGED", out)

        # history --json
        rc, out, err = self.cas("history", self.target, "--json")
        self.assertEqual(rc, 0, err)
        self.assertTrue(json.loads(out)["revisions"])

        # restore -> 원복 + 백업/되돌림 스냅샷
        rc, out, err = self.cas("restore", self.target, "--from", sid)
        self.assertEqual(rc, 0, err)
        res = json.loads(out)
        self.assertTrue(res["ok"])
        self.assertIsNotNone(res["pre_snapshot"])  # 복원 전 상태 보존
        with open(self.target, encoding="utf-8") as f:
            self.assertEqual(f.read(), "v1 line A\nv1 line B\n")

    def test_cat_tracked_only(self):
        # cat: 추적 파일은 현재 내용 그대로, 추적 밖 경로는 거부.
        self.cas("init")
        self.cas("track", self.target)
        rc, out, err = self.cas("cat", self.target)
        self.assertEqual(rc, 0, err)
        self.assertEqual(out, "v1 line A\nv1 line B\n")
        outside = os.path.join(self.tmp, "outside.txt")
        with open(outside, "w") as f:
            f.write("x")
        rc, out, err = self.cas("cat", outside)
        self.assertNotEqual(rc, 0)
        self.assertFalse(json.loads(out)["ok"])

    def test_crlf_content_not_double_newlined(self):
        # 회귀: stdout 이 텍스트 모드면 쓸 때 \n 이 \r\n 으로 바뀌어, 이미 CRLF 인 파일 내용이
        # \r\r\n 이 된다. 그러면 파일 뷰어/diff 에서 개행이 2번으로 보인다(빈 줄).
        # cat/diff 모두 바이트 그대로 나와야 한다.
        f = os.path.join(self.tmp, "crlf.txt")
        with open(f, "wb") as fh:
            fh.write(b"A\n")
        self.cas("init")
        self.cas("track", f)
        self.cas("snapshot", "-m", "base")
        with open(f, "wb") as fh:
            fh.write(b"A\r\nB\r\n")   # 에디터가 CRLF 로 다시 씀

        def raw(*args):
            e = dict(os.environ)
            e["CLAUDE_CAS_NO_DEFAULT_TRACK"] = "1"
            p = subprocess.run([sys.executable, CAS, "--store", self.store, *args],
                               capture_output=True, env=e, timeout=60)   # bytes(개행 변환 없음)
            self.assertEqual(p.returncode, 0, p.stderr)
            return p.stdout

        self.assertEqual(raw("cat", f), b"A\r\nB\r\n")    # 내용 그대로
        self.assertNotIn(b"\r\r\n", raw("diff", f))       # diff 의 + 줄도 doubling 없음

    def test_watcher_status_no_watcher(self):
        self.cas("init")
        rc, out, err = self.cas("watcher-status")
        self.assertEqual(rc, 0, err)
        self.assertFalse(json.loads(out)["running"])

    def test_watcher_status_bom_and_tzaware(self):
        # PS 가 쓰는 형태(UTF-8 BOM + tz-aware "+09:00" heartbeat) 를 견디는지.
        self.cas("init")
        from datetime import datetime, timezone, timedelta
        now = datetime.now(timezone(timedelta(hours=9))).isoformat()
        state = {"pid": 9999, "started": now, "heartbeat": now, "debounceMs": 2000, "dirs": []}
        wj = os.path.join(self.store, "watcher.json")
        with open(wj, "w", encoding="utf-8-sig") as f:  # BOM 포함
            f.write(json.dumps(state))
        rc, out, err = self.cas("watcher-status")
        self.assertEqual(rc, 0, err)
        s = json.loads(out)
        self.assertTrue(s["running"])      # 방금 heartbeat -> 살아있음
        self.assertIsNotNone(s["age_sec"])  # tz-aware 빼기 성공

    def test_watcher_status_ps_roundtrip_fraction(self):
        # 회귀 가드: PowerShell (Get-Date).ToString("o") 는 소수부 7자리(tick) —
        # Python<3.11 fromisoformat 이 못 읽어 watcher 가 영원히 '정지'로 보였다.
        self.cas("init")
        from datetime import datetime, timezone, timedelta
        now = datetime.now(timezone(timedelta(hours=9)))
        hb = now.strftime("%Y-%m-%dT%H:%M:%S") + ".1970395+09:00"  # 7자리 소수부
        state = {"pid": 9999, "started": hb, "heartbeat": hb, "debounceMs": 2000, "dirs": []}
        with open(os.path.join(self.store, "watcher.json"), "w", encoding="utf-8") as f:
            f.write(json.dumps(state))
        rc, out, err = self.cas("watcher-status")
        self.assertEqual(rc, 0, err)
        s = json.loads(out)
        self.assertIsNone(s["error"], f"7자리 소수부 파싱 실패: {s['error']}")
        self.assertTrue(s["running"])

    def test_default_tracked_merge(self):
        # DEFAULT_TRACKED 자동 병합: 가짜 HOME 으로 존재를 보장해 머신 독립적으로 검증.
        self.cas("init")
        fake_home = os.path.join(self.tmp, "home")
        os.makedirs(os.path.join(fake_home, ".claude"), exist_ok=True)
        with open(os.path.join(fake_home, ".claude.json"), "w") as f:
            f.write("{}")
        with open(os.path.join(fake_home, ".claude", "settings.json"), "w") as f:
            f.write("{}")
        e = dict(os.environ)
        e.pop("CLAUDE_CAS_NO_DEFAULT_TRACK", None)
        e["HOME"] = fake_home
        e["USERPROFILE"] = fake_home
        p = subprocess.run([sys.executable, CAS, "--store", self.store, "status", "--json"],
                           capture_output=True, text=True, encoding="utf-8", env=e, timeout=60)
        self.assertEqual(p.returncode, 0, p.stderr)
        with open(os.path.join(self.store, "config.json"), encoding="utf-8") as f:
            cfg = json.load(f)
        self.assertIn(os.path.join(fake_home, ".claude.json"), cfg["tracked"])
        self.assertIn(os.path.join(fake_home, ".claude", "settings.json"), cfg["tracked"])

    def test_untrack_default_not_resurrected(self):
        # untrack 한 기본 대상이 자동 병합으로 되살아나지 않아야 한다(ignore_defaults).
        self.cas("init")
        fake_home = os.path.join(self.tmp, "home")
        os.makedirs(fake_home, exist_ok=True)
        cj = os.path.join(fake_home, ".claude.json")
        with open(cj, "w") as f:
            f.write("{}")
        e = dict(os.environ)
        e.pop("CLAUDE_CAS_NO_DEFAULT_TRACK", None)
        e["HOME"] = fake_home
        e["USERPROFILE"] = fake_home
        def cas_env(*args):
            return subprocess.run([sys.executable, CAS, "--store", self.store, *args],
                                  capture_output=True, text=True, encoding="utf-8", env=e, timeout=60)
        cas_env("status", "--json")     # 병합 발생
        cas_env("untrack", cj)          # 명시 제외
        cas_env("status", "--json")     # 재병합 시도
        with open(os.path.join(self.store, "config.json"), encoding="utf-8") as f:
            cfg = json.load(f)
        self.assertNotIn(cj, cfg["tracked"])
        self.assertIn(cj, cfg.get("ignore_defaults", []))


class ConfigEdit(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="edit_test_")
        # 실제 형태(<root>/.claude/settings.json)로 픽스처를 잡는다 - config_edit 이 이 형태만 받는다.
        self.settings = os.path.join(self.tmp, ".claude", "settings.json")
        os.makedirs(os.path.dirname(self.settings), exist_ok=True)
        with open(self.settings, "w", encoding="utf-8") as f:
            json.dump({"permissions": {"allow": ["Bash(ls)"]}}, f)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def edit(self, *args):
        return run(EDIT, "--settings", self.settings, "--no-snapshot", *args)

    def _load(self):
        with open(self.settings, encoding="utf-8") as f:
            return json.load(f)

    def test_perm_add_remove(self):
        rc, out, err = self.edit("perm-add", "allow", "Bash(git*)")
        self.assertEqual(rc, 0, err)
        self.assertTrue(json.loads(out)["ok"])
        self.assertIn("Bash(git*)", self._load()["permissions"]["allow"])

        rc, out, err = self.edit("perm-remove", "allow", "Bash(git*)")
        self.assertEqual(rc, 0, err)
        self.assertNotIn("Bash(git*)", self._load()["permissions"]["allow"])

    def test_hook_remove_quoted_command(self):
        # 회귀: needle 을 직렬화된 JSON 에 부분 문자열로 맞추면 명령 안의 " 가 \" 로 이스케이프돼
        # 절대 매칭되지 않는다. 경로를 따옴표로 감싼 훅(실제로 가장 흔한 형태)이 제거 불가였다.
        cmd = 'node "C:/tools/hooks/lint.js"'
        self.edit("hook-add", "PostToolUse", cmd, "--matcher", "Edit")
        rc, out, err = self.edit("hook-remove", "PostToolUse", cmd)
        self.assertEqual(rc, 0, err)
        self.assertTrue(json.loads(out)["changed"], "따옴표 포함 명령이 제거되지 않음")
        self.assertNotIn("hooks", self._load())   # 마지막 훅이 빠지면 빈 껍데기도 남기지 않는다

    def test_hook_remove_is_exact_not_substring(self):
        # 회귀: 부분 문자열 매칭이면 짧은 명령을 지울 때 그것을 접두로 갖는 다른 훅까지 사라진다.
        self.edit("hook-add", "PostToolUse", "node hook.js")
        self.edit("hook-add", "PostToolUse", "node hook.js --verbose")
        rc, out, err = self.edit("hook-remove", "PostToolUse", "node hook.js")
        self.assertEqual(rc, 0, err)
        cmds = [hk["command"] for ent in self._load()["hooks"]["PostToolUse"]
                for hk in ent.get("hooks", [])]
        self.assertEqual(cmds, ["node hook.js --verbose"], "부분 문자열 매칭으로 다른 훅까지 제거됨")

    def test_hook_remove_keeps_sibling_in_same_entry(self):
        # 회귀: 한 matcher 엔트리에 훅이 여러 개면(손으로 작성한 형태) 엔트리째 버려서
        # 지목하지 않은 형제 훅까지 사라졌다. 훅 단위로 지우고 빈 엔트리만 정리해야 한다.
        with open(self.settings, "w", encoding="utf-8") as f:
            json.dump({"hooks": {"PostToolUse": [{"matcher": "Edit", "hooks": [
                {"type": "command", "command": "a.py"},
                {"type": "command", "command": "b.py"}]}]}}, f)
        rc, out, err = self.edit("hook-remove", "PostToolUse", "a.py")
        self.assertEqual(rc, 0, err)
        cmds = [hk["command"] for ent in self._load()["hooks"]["PostToolUse"]
                for hk in ent.get("hooks", [])]
        self.assertEqual(cmds, ["b.py"], "같은 엔트리의 형제 훅이 함께 삭제됨")

    def test_edit_accepts_bom_settings(self):
        # PowerShell Out-File 등이 남기는 UTF-8 BOM. utf-8 로 열면 json.load 가 거부해
        # 모든 편집이 트레이스백으로 죽고 stdout 순수 JSON 계약도 깨진다.
        with open(self.settings, "w", encoding="utf-8-sig") as f:
            json.dump({"permissions": {"allow": ["Bash(ls)"]}}, f)
        rc, out, err = self.edit("perm-add", "allow", "Bash(git*)")
        self.assertEqual(rc, 0, err)
        self.assertTrue(json.loads(out)["ok"])
        self.assertIn("Bash(git*)", self._load()["permissions"]["allow"])

    def test_null_sections_do_not_crash_edit(self):
        # 손편집으로 남는 null. permissions/hooks 가 null 이면 setdefault 결과가 None 이라
        # AttributeError/TypeError 로 죽고 JSON 대신 트레이스백이 나갔다.
        with open(self.settings, "w", encoding="utf-8") as f:
            json.dump({"permissions": None, "hooks": None}, f)
        rc, out, err = self.edit("perm-add", "allow", "Bash(git*)")
        self.assertEqual(rc, 0, err)
        self.assertIn("Bash(git*)", self._load()["permissions"]["allow"])
        rc, out, err = self.edit("hook-remove", "PostToolUse", "x")
        self.assertEqual(rc, 0, err)  # 없는 훅 제거는 no-op(정상 종료)

    def test_hook_add_remove(self):
        rc, out, err = self.edit("hook-add", "PostToolUse", "echo hi", "--matcher", "Edit")
        self.assertEqual(rc, 0, err)
        self.assertTrue(any("echo hi" in json.dumps(h) for h in self._load()["hooks"]["PostToolUse"]))

        rc, out, err = self.edit("hook-remove", "PostToolUse", "echo hi")
        self.assertEqual(rc, 0, err)
        self.assertTrue(json.loads(out)["changed"])
        # 비게 된 이벤트 키/hooks 는 남기지 않는다(빈 배열이 쌓이면 설정 파일이 지저분해진다).
        self.assertNotIn("hooks", self._load())

    def test_hook_remove_matches_windows_path_command(self):
        """대시보드가 카드에 표시하는 command 원문(백슬래시 경로)이 needle 로 그대로 온다.

        회귀 가드: 직렬화 결과(json.dumps)에 매칭하던 구버전은 JSON 이 \\ 를 \\\\ 로
        이스케이프해 이런 needle 을 영원히 못 찾았다 - ok:true / changed:false 로 조용히
        no-op 이 되어 "설정에서 hooks 삭제가 안 된다"로 나타났다."""
        cmd = r'node "D:\my-tools\Hooks\recursive-eval\index.js"'
        rc, out, err = self.edit("hook-add", "PostToolUse", cmd, "--matcher", "Edit")
        self.assertEqual(rc, 0, err)

        rc, out, err = self.edit("hook-remove", "PostToolUse", cmd)
        self.assertEqual(rc, 0, err)
        res = json.loads(out)
        self.assertTrue(res["ok"])
        self.assertTrue(res["changed"], "백슬래시 경로 needle 이 매칭되지 않았다")
        self.assertNotIn("hooks", self._load())

    def test_hook_remove_keeps_siblings_in_the_same_matcher(self):
        # UI 가 나열하는 단위는 command 다 - 같은 matcher 에 묶인 다른 hook 까지 날리면 안 된다.
        with open(self.settings, "w", encoding="utf-8") as f:
            json.dump({"hooks": {"PreToolUse": [{"matcher": "*", "hooks": [
                {"type": "command", "command": "keep-me"},
                {"type": "command", "command": "drop-me"}]}]}}, f)
        rc, out, err = self.edit("hook-remove", "PreToolUse", "drop-me")
        self.assertEqual(rc, 0, err)
        left = self._load()["hooks"]["PreToolUse"]
        self.assertEqual([h["command"] for h in left[0]["hooks"]], ["keep-me"])

    def test_hook_remove_reports_no_op_when_nothing_matches(self):
        # 조용한 실패 가드: 지운 게 없으면 changed:false 로 알려야 UI 가 "제거됨"을 띄우지 않는다.
        self.edit("hook-add", "PostToolUse", "echo hi")
        rc, out, err = self.edit("hook-remove", "PostToolUse", "no-such-command")
        self.assertEqual(rc, 0, err)
        self.assertFalse(json.loads(out)["changed"])

    def test_settings_outside_claude_dir_is_rejected(self):
        # --settings 는 도구 파라미터로 노출돼 있다. 검증이 없으면 save_atomic 의 makedirs 가
        # 임의 경로에 트리를 만들며 JSON 을 쓴다 - 파일이 생기지 않았다는 것까지 확인한다.
        bad = os.path.join(self.tmp, "not-a-claude-dir", "deep", "arbitrary.json")
        rc, out, err = run(EDIT, "--settings", bad, "--no-snapshot",
                           "perm-add", "allow", "Bash(rm -rf /)")
        self.assertEqual(rc, 1, out)
        self.assertFalse(json.loads(out)["ok"])
        self.assertFalse(os.path.exists(os.path.dirname(bad)))

    def test_settings_local_json_in_claude_dir_is_accepted(self):
        # 거부 규칙이 실제 대상까지 막지 않는지: Claude 가 읽는 두 이름 중 나머지 하나.
        local = os.path.join(self.tmp, ".claude", "settings.local.json")
        rc, out, err = run(EDIT, "--settings", local, "--no-snapshot",
                           "perm-add", "allow", "Bash(git*)")
        self.assertEqual(rc, 0, err)
        with open(local, encoding="utf-8") as f:
            self.assertIn("Bash(git*)", json.load(f)["permissions"]["allow"])


class ConfigEditExtended(unittest.TestCase):
    """mcpServers / skills / agents 확장 ops. 실사용자 파일 대신 temp 경로로 격리."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="edit_ext_")
        self.claude_json = os.path.join(self.tmp, "claude.json")
        self.desktop = os.path.join(self.tmp, "desktop_config.json")
        # 실제 형태(<root>/.claude/<sub>)로 픽스처를 잡는다 - config_edit 이 이 형태만 받는다.
        self.skills = os.path.join(self.tmp, ".claude", "skills")
        self.agents = os.path.join(self.tmp, ".claude", "agents")
        with open(self.claude_json, "w", encoding="utf-8") as f:
            json.dump({"mcpServers": {}, "other": "keep"}, f)
        with open(self.desktop, "w", encoding="utf-8") as f:
            json.dump({"mcpServers": {"pre": {"command": "x"}}}, f)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def edit(self, *args):
        return run(EDIT, "--claude-json", self.claude_json, "--desktop-config", self.desktop,
                   "--skills-dir", self.skills, "--agents-dir", self.agents, "--no-snapshot", *args)

    def _load(self, path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)

    def test_mcp_add_remove_user_scope(self):
        rc, out, err = self.edit("mcp-add", "weather", "--json", '{"command":"npx","args":["-y","weather-mcp"]}')
        self.assertEqual(rc, 0, err)
        self.assertTrue(json.loads(out)["ok"])
        d = self._load(self.claude_json)
        self.assertEqual(d["mcpServers"]["weather"]["command"], "npx")
        self.assertEqual(d["other"], "keep")  # 무관 키 보존

        rc, out, err = self.edit("mcp-remove", "weather")
        self.assertEqual(rc, 0, err)
        self.assertNotIn("weather", self._load(self.claude_json)["mcpServers"])

    def test_mcp_desktop_scope_and_invalid_json(self):
        rc, out, err = self.edit("mcp-add", "s2", "--scope", "desktop", "--json", '{"command":"uv"}')
        self.assertEqual(rc, 0, err)
        d = self._load(self.desktop)
        self.assertIn("s2", d["mcpServers"])
        self.assertIn("pre", d["mcpServers"])  # 기존 서버 보존

        rc, out, err = self.edit("mcp-add", "bad", "--json", "not-json")
        self.assertNotEqual(rc, 0)
        self.assertFalse(json.loads(out)["ok"])

        # remove no-op 은 ok=True/changed=False
        rc, out, err = self.edit("mcp-remove", "ghost")
        self.assertEqual(rc, 0, err)
        self.assertFalse(json.loads(out)["changed"])

    def test_skill_scaffold_remove_roundtrip(self):
        rc, out, err = self.edit("skill-scaffold", "myskill", "--desc", "테스트")
        self.assertEqual(rc, 0, err)
        self.assertTrue(os.path.exists(os.path.join(self.skills, "myskill", "SKILL.md")))

        rc, out, err = self.edit("skill-remove", "myskill")
        self.assertEqual(rc, 0, err)
        res = json.loads(out)
        self.assertFalse(os.path.exists(os.path.join(self.skills, "myskill")))
        self.assertTrue(os.path.exists(res["trashed"]))  # 복구 가능(.trash 이동)

    def test_agent_scaffold_remove_roundtrip(self):
        rc, out, err = self.edit("agent-scaffold", "reviewer", "--desc", "코드리뷰", "--tools", "Read,Grep")
        self.assertEqual(rc, 0, err)
        md = os.path.join(self.agents, "reviewer.md")
        with open(md, encoding="utf-8") as f:
            body = f.read()
        self.assertIn("tools: Read,Grep", body)

        rc, out, err = self.edit("agent-remove", "reviewer")
        self.assertEqual(rc, 0, err)
        self.assertFalse(os.path.exists(md))

    def test_path_traversal_rejected(self):
        rc, out, err = self.edit("skill-remove", "../evil")
        self.assertNotEqual(rc, 0)
        self.assertFalse(json.loads(out)["ok"])

    def test_bad_skills_dir_rejected(self):
        """--skills-dir 가 MCP 도구로 노출되므로 <...>/.claude/skills 아닌 경로는 trash() 전에 거부."""
        victim = os.path.join(self.tmp, "notclaude", "skills", "myskill")
        os.makedirs(victim)
        rc, out, err = run(EDIT, "--skills-dir", os.path.dirname(victim), "--no-snapshot",
                           "skill-remove", "myskill")
        self.assertNotEqual(rc, 0)
        self.assertFalse(json.loads(out)["ok"])
        self.assertTrue(os.path.isdir(victim))          # 그대로 남아야 함

    def test_agent_full_content_install(self):
        # --content: 업로드된 완전한 md(frontmatter+본문)를 그대로 설치, 스텁 아님.
        content = ("---\nname: sec\ndescription: 보안 리뷰어\n"
                   'tools: ["Read", "Bash"]\nmodel: sonnet\n---\n\n# 본문\n\n워크플로우 상세.\n')
        rc, out, err = self.edit("agent-scaffold", "sec", "--content", content)
        self.assertEqual(rc, 0, err)
        with open(os.path.join(self.agents, "sec.md"), encoding="utf-8") as f:
            self.assertEqual(f.read(), content)   # 그대로(verbatim) 기록
        # 중복 설치는 거부
        rc, out, err = self.edit("agent-scaffold", "sec", "--content", content)
        self.assertNotEqual(rc, 0)

    def test_skill_full_content_install(self):
        content = "---\nname: myskill\ndescription: d\n---\n\n# 단계\n1. one\n"
        rc, out, err = self.edit("skill-scaffold", "myskill", "--content", content)
        self.assertEqual(rc, 0, err)
        with open(os.path.join(self.skills, "myskill", "SKILL.md"), encoding="utf-8") as f:
            self.assertEqual(f.read(), content)


class LibraryToggle(unittest.TestCase):
    """library.py: 스캔 3상태 판정 + 설치/동기화/제거 라운드트립."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="lib_test_")
        self.store = os.path.join(self.tmp, "store")
        self.lib = os.path.join(self.tmp, "kit", ".claude")
        self.target = os.path.join(self.tmp, ".claude")
        # 라이브러리 구성: agent 1, skill 1, command 1
        os.makedirs(os.path.join(self.lib, "agents"))
        os.makedirs(os.path.join(self.lib, "skills", "s1"))
        os.makedirs(os.path.join(self.lib, "commands"))
        with open(os.path.join(self.lib, "agents", "a1.md"), "w", encoding="utf-8") as f:
            f.write("---\nname: a1\n---\nagent body\n")
        with open(os.path.join(self.lib, "skills", "s1", "SKILL.md"), "w", encoding="utf-8") as f:
            f.write("---\nname: s1\n---\nskill body\n")
        with open(os.path.join(self.lib, "commands", "c1.md"), "w", encoding="utf-8") as f:
            f.write("command body — ${CLAUDE_PROJECT_DIR} 참조\n")
        # store 초기화 + 라이브러리 등록
        run(CAS, "--store", self.store, "init")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def libcmd(self, *args):
        return run(LIB, "--store", self.store, "--target", self.target, "--no-snapshot", *args)

    def _scan(self):
        rc, out, err = self.libcmd("scan", "--lib", self.lib)
        self.assertEqual(rc, 0, err)
        res = json.loads(out)
        items = {}
        for l in res["libraries"]:
            for cat, arr in l["categories"].items():
                for it in arr:
                    items[f"{cat}/{it['name']}"] = it
        return items

    def test_install_target_outside_claude_root_is_rejected(self):
        # targetDir 은 '.claude 루트'가 계약이다(도구 설명 · UI 후보 목록 모두). cmd_install 의
        # 부모 존재 검사만으로는 존재하는 아무 디렉토리나 통과해 임의 위치에 파일이 심긴다.
        outside = os.path.join(self.tmp, "not-claude")
        os.makedirs(outside)
        rc, out, err = run(LIB, "--store", self.store, "--target", outside, "--no-snapshot",
                           "install", "agents", "a1", "--lib", self.lib)
        self.assertEqual(rc, 1, out)
        self.assertFalse(json.loads(out)["ok"])
        self.assertEqual(os.listdir(outside), [])

    def test_scan_install_modify_sync_uninstall(self):
        # 1) 초기 스캔: 전부 미설치, kit 참조 휴리스틱 동작
        items = self._scan()
        self.assertEqual(items["agents/a1"]["status"], "not_installed")
        self.assertEqual(items["skills/s1"]["status"], "not_installed")
        self.assertTrue(items["commands/c1"]["kit_ref"])   # ${CLAUDE_PROJECT_DIR} 감지
        self.assertFalse(items["agents/a1"]["kit_ref"])

        # 2) 설치 -> installed
        for cat, name in (("agents", "a1"), ("skills", "s1"), ("commands", "c1")):
            rc, out, err = self.libcmd("install", cat, name, "--lib", self.lib)
            self.assertEqual(rc, 0, err)
        items = self._scan()
        self.assertEqual(items["agents/a1"]["status"], "installed")
        self.assertEqual(items["skills/s1"]["status"], "installed")

        # 3) 라이브 쪽 수정 -> modified
        with open(os.path.join(self.target, "agents", "a1.md"), "a", encoding="utf-8") as f:
            f.write("local edit\n")
        with open(os.path.join(self.target, "skills", "s1", "extra.txt"), "w") as f:
            f.write("x")   # 파일 추가도 감지되어야 함
        items = self._scan()
        self.assertEqual(items["agents/a1"]["status"], "modified")
        self.assertEqual(items["skills/s1"]["status"], "modified")

        # 4) 동기화(재설치): 파일은 .bak, 디렉토리는 .trash 백업 후 라이브러리 버전으로
        rc, out, err = self.libcmd("install", "agents", "a1", "--lib", self.lib)
        self.assertEqual(rc, 0, err)
        res = json.loads(out)
        self.assertTrue(res["synced"])
        self.assertTrue(res["backup"] and os.path.exists(res["backup"]))
        rc, out, err = self.libcmd("install", "skills", "s1", "--lib", self.lib)
        self.assertEqual(rc, 0, err)
        self.assertTrue(os.path.exists(json.loads(out)["backup"]))  # .trash 이동분
        items = self._scan()
        self.assertEqual(items["agents/a1"]["status"], "installed")
        self.assertEqual(items["skills/s1"]["status"], "installed")

        # 5) 제거 -> .trash + not_installed
        rc, out, err = self.libcmd("uninstall", "agents", "a1")
        self.assertEqual(rc, 0, err)
        self.assertTrue(os.path.exists(json.loads(out)["trashed"]))
        items = self._scan()
        self.assertEqual(items["agents/a1"]["status"], "not_installed")

    def test_library_registration_persisted(self):
        self.libcmd("scan", "--lib", self.lib)
        with open(os.path.join(self.store, "config.json"), encoding="utf-8") as f:
            cfg = json.load(f)
        self.assertIn(self.lib, cfg.get("libraries", []))
        # 등록 후에는 --lib 없이 스캔 가능
        rc, out, err = self.libcmd("scan")
        self.assertEqual(rc, 0, err)

    def test_invalid_name_rejected(self):
        rc, out, err = self.libcmd("uninstall", "agents", "..\\evil")
        self.assertNotEqual(rc, 0)

    def test_install_refuses_phantom_target(self):
        # local 설치: target 의 부모(프로젝트 폴더)가 없으면 거부 — 엉뚱한 위치에 .claude 흩뿌리기 방지.
        self._scan()  # 라이브러리 등록
        phantom = os.path.join(self.tmp, "nonexistent-project", ".claude")  # 부모 미존재
        rc, out, err = run(LIB, "--store", self.store, "--target", phantom, "--no-snapshot",
                           "install", "agents", "a1", "--lib", self.lib)
        self.assertNotEqual(rc, 0, "phantom 부모면 거부해야 함")
        self.assertFalse(json.loads(out)["ok"])
        self.assertFalse(os.path.exists(phantom), "거부 시 .claude 를 만들지 않아야 함")

    def test_install_allows_existing_parent_target(self):
        # 부모(프로젝트 폴더)가 존재하면 .claude 하위 생성은 정상 첫 설치로 허용.
        self._scan()
        proj = os.path.join(self.tmp, "real-project")
        os.makedirs(proj)  # 부모 존재, .claude 는 아직 없음
        tgt = os.path.join(proj, ".claude")
        rc, out, err = run(LIB, "--store", self.store, "--target", tgt, "--no-snapshot",
                           "install", "agents", "a1", "--lib", self.lib)
        self.assertEqual(rc, 0, err)
        self.assertTrue(os.path.exists(os.path.join(tgt, "agents", "a1.md")))

    def test_env_declared_library(self):
        # CLAUDE_CONFIG_LIBRARIES: 등록 없이 env 만으로 스캔 대상이 되고(선언적),
        # env 에서 빠지면 목록에서도 빠진다(store 에 영속되지 않음).
        env = {"CLAUDE_CONFIG_LIBRARIES": self.lib}
        rc, out, err = run(LIB, "--store", self.store, "--target", self.target,
                           "--no-snapshot", "scan", env=env)
        self.assertEqual(rc, 0, err)
        res = json.loads(out)
        self.assertEqual([l["lib"] for l in res["libraries"]], [self.lib])
        # store config 에는 영속되지 않아야 함
        with open(os.path.join(self.store, "config.json"), encoding="utf-8") as f:
            self.assertNotIn(self.lib, json.load(f).get("libraries", []))
        # env 제거 -> 미설정은 오류가 아니라 빈 결과(정상 종료)
        rc, out, err = self.libcmd("scan")
        self.assertEqual(rc, 0, err)
        res = json.loads(out)
        self.assertTrue(res["ok"])
        self.assertEqual(res["libraries"], [])


class TrackProjectPreset(unittest.TestCase):
    """cas.py track: 디렉토리 -> 프로젝트 프리셋(settings.json + settings.local.json) 확장,
    파일/글롭은 그대로. status --json 의 defaults 로 전역/프로젝트 분류."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="track_test_")
        self.store = os.path.join(self.tmp, "store")
        run(CAS, "--store", self.store, "init")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def cas(self, *args):
        return run(CAS, "--store", self.store, *args)

    def _nc(self, p):
        return os.path.normcase(os.path.abspath(p))

    def _make(self, path, body="{}"):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(body)
        return path

    def test_track_project_dir_expands_preset(self):
        # 프로젝트 루트를 주면 <root>/.claude 의 settings.json + settings.local.json 을 추적.
        proj = os.path.join(self.tmp, "repoA")
        s = self._make(os.path.join(proj, ".claude", "settings.json"))
        sl = self._make(os.path.join(proj, ".claude", "settings.local.json"))
        rc, out, err = self.cas("track", "--json", proj)
        self.assertEqual(rc, 0, err)
        added = {self._nc(x) for x in json.loads(out)["added"]}
        self.assertEqual(added, {self._nc(s), self._nc(sl)})

    def test_track_project_dir_expands_prose_preset(self):
        # CLAUDE.md 는 산문이라 카드가 아니라 추적 대상. 루트와 .claude 양쪽 모두 잡아야 한다
        # (PROJECT_PRESET 은 .claude 기준이라 루트의 CLAUDE.md 를 놓치기 쉬움).
        proj = os.path.join(self.tmp, "repoP")
        s = self._make(os.path.join(proj, ".claude", "settings.json"))
        md = self._make(os.path.join(proj, "CLAUDE.md"), "# rules")
        lmd = self._make(os.path.join(proj, "CLAUDE.local.md"), "# local")
        cmd = self._make(os.path.join(proj, ".claude", "CLAUDE.md"), "# in-claude")
        rc, out, err = self.cas("track", "--json", proj)
        self.assertEqual(rc, 0, err)
        added = {self._nc(x) for x in json.loads(out)["added"]}
        self.assertEqual(added, {self._nc(s), self._nc(md), self._nc(lmd), self._nc(cmd)})

    def test_track_claude_dir_directly(self):
        # .claude 디렉토리를 직접 주면 그 안의 프리셋을 추적(settings.local 없으면 settings 만).
        cdir = os.path.join(self.tmp, "repoB", ".claude")
        s = self._make(os.path.join(cdir, "settings.json"))
        rc, out, err = self.cas("track", "--json", cdir)
        self.assertEqual(rc, 0, err)
        added = {self._nc(x) for x in json.loads(out)["added"]}
        self.assertEqual(added, {self._nc(s)})

    def test_track_file_path_backward_compat(self):
        # 파일 경로를 직접 주면 그 파일만 추적(기존 동작 유지).
        f = self._make(os.path.join(self.tmp, "repoC", ".claude", "settings.json"))
        rc, out, err = self.cas("track", "--json", f)
        self.assertEqual(rc, 0, err)
        self.assertEqual({self._nc(x) for x in json.loads(out)["added"]}, {self._nc(f)})

    def test_track_dir_without_config_adds_nothing(self):
        # 설정 파일 없는 폴더 -> 추가 0건(오류 아님).
        empty = os.path.join(self.tmp, "repoD", ".claude")
        os.makedirs(empty)
        rc, out, err = self.cas("track", "--json", empty)
        self.assertEqual(rc, 0, err)
        self.assertEqual(json.loads(out)["added"], [])
        self.assertEqual(json.loads(out)["not_found"], [])

    def test_track_reports_paths_that_do_not_exist(self):
        # 오타 경로도 추적은 된다(나중에 생길 파일을 미리 거는 건 의도된 기능). 다만 어느 것이
        # 아직 없는지 알려야 화면이 그걸 말할 수 있다 - 조용히 넣으면 유령 행으로 남는다.
        ghost = os.path.join(self.tmp, "nope", "settings.json")
        rc, out, err = self.cas("track", "--json", ghost)
        self.assertEqual(rc, 0, err)
        res = json.loads(out)
        self.assertEqual({self._nc(x) for x in res["added"]}, {self._nc(ghost)})
        self.assertEqual({self._nc(x) for x in res["not_found"]}, {self._nc(ghost)})

    def test_track_does_not_flag_existing_file_as_missing(self):
        f = self._make(os.path.join(self.tmp, "repoE", ".claude", "settings.json"))
        rc, out, err = self.cas("track", "--json", f)
        self.assertEqual(rc, 0, err)
        self.assertEqual(json.loads(out)["not_found"], [])

    def test_untrack_removes_project_file(self):
        f = self._make(os.path.join(self.tmp, "repoE", ".claude", "settings.json"))
        self.cas("track", "--json", f)
        rc, out, err = self.cas("untrack", "--json", f)
        self.assertEqual(rc, 0, err)
        self.assertTrue(json.loads(out)["ok"])
        st = json.loads(self.cas("status", "--json")[1])
        allpaths = [p for k in ("new", "modified", "deleted", "unchanged") for p in st.get(k, [])]
        self.assertNotIn(self._nc(f), [self._nc(x) for x in allpaths])

    def test_untrack_removes_deleted_from_index(self):
        # 회귀: 스냅샷된(index 에 든) 프로젝트 파일을 삭제하면 status 는 deleted 로 잡는다.
        # untrack 은 config 뿐 아니라 index 에서도 빼야 하며, 안 그러면 계속 deleted 로 남는다.
        f = self._make(os.path.join(self.tmp, "repoF", ".claude", "settings.json"))
        self.cas("track", "--json", f)
        self.cas("snapshot")                      # index 에 등록
        os.remove(f)                              # 파일 삭제 -> status = deleted
        st = json.loads(self.cas("status", "--json")[1])
        self.assertIn(self._nc(f), [self._nc(x) for x in st.get("deleted", [])])
        r = json.loads(self.cas("untrack", "--json", f)[1])
        self.assertTrue(r["ok"])
        self.assertEqual(r["index_removed"], 1)
        st2 = json.loads(self.cas("status", "--json")[1])
        allpaths = [p for k in ("new", "modified", "deleted", "unchanged") for p in st2.get(k, [])]
        self.assertNotIn(self._nc(f), [self._nc(x) for x in allpaths])

    def test_untrack_directory_entry_purges_index_subtree(self):
        # 회귀: 구버전 track 은 디렉토리를 확장 없이 raw 로 저장했다. 이런 레거시 항목을
        # untrack 하면 index 에는 '하위 파일' 경로들이 들어 있어 정확 일치로는 하나도 안 지워지고,
        # 하위 파일 전부가 deleted 로 계속 표시된다. 디렉토리 항목은 하위 index 도 지워야 한다.
        proj = os.path.join(self.tmp, "legacy")
        self._make(os.path.join(proj, "a.txt"), "a")
        self._make(os.path.join(proj, "sub", "b.txt"), "b")
        cfg_path = os.path.join(self.store, "config.json")
        with open(cfg_path, encoding="utf-8") as f:
            cfg = json.load(f)
        cfg["tracked"].append(os.path.abspath(proj))   # 레거시 상태 재현(raw 디렉토리)
        with open(cfg_path, "w", encoding="utf-8") as f:
            json.dump(cfg, f)
        self.cas("snapshot")                           # 하위 파일들이 index 에 등록
        r = json.loads(self.cas("untrack", "--json", proj)[1])
        self.assertTrue(r["ok"])
        self.assertEqual(r["index_removed"], 2, "디렉토리 하위 index 항목이 제거돼야 함")
        st = json.loads(self.cas("status", "--json")[1])
        allpaths = [self._nc(x) for k in ("new", "modified", "deleted", "unchanged")
                    for x in st.get(k, [])]
        prefix = self._nc(proj) + os.sep
        self.assertFalse(any(p.startswith(prefix) for p in allpaths),
                         "untrack 후에도 하위 파일이 status 에 남음(deleted 잔존)")

    def test_status_defaults_classifies_global_vs_project(self):
        # fake HOME 의 ~/.claude.json 은 DEFAULT_TRACKED(전역)로 분류, 프로젝트 파일은 아님.
        fake_home = os.path.join(self.tmp, "home")
        gj = self._make(os.path.join(fake_home, ".claude.json"))
        pf = self._make(os.path.join(self.tmp, "repoF", ".claude", "settings.json"))
        e = dict(os.environ)
        e.pop("CLAUDE_CAS_NO_DEFAULT_TRACK", None)  # 기본 병합 켬
        e["HOME"] = fake_home
        e["USERPROFILE"] = fake_home
        def cas_env(*args):
            return subprocess.run([sys.executable, CAS, "--store", self.store, *args],
                                  capture_output=True, text=True, encoding="utf-8", env=e, timeout=60)
        cas_env("track", "--json", pf)          # 프로젝트 파일 수동 추적
        p = cas_env("status", "--json")         # 이때 fake ~/.claude.json 자동 병합
        self.assertEqual(p.returncode, 0, p.stderr)
        st = json.loads(p.stdout)
        defaults = st.get("defaults", [])
        self.assertTrue(any(self._nc(d) == self._nc(gj) for d in defaults))   # 전역 = default
        self.assertFalse(any(self._nc(d) == self._nc(pf) for d in defaults))  # 프로젝트 = default 아님
        # UI 불변식: renderTracked 는 defaults(원문 문자열) 집합에 버킷 경로를 .has() 로 매칭.
        # 따라서 모든 default 문자열이 status 버킷에 byte-identical 로 존재해야 배지가 안 깨진다.
        bset = {x for k in ("new", "modified", "deleted", "unchanged") for x in st.get(k, [])}
        for d in defaults:
            self.assertIn(d, bset, f"default {d!r} 가 status 버킷과 정규화 불일치 -> UI 전역/프로젝트 배지 깨짐")


class DesktopPathResolve(unittest.TestCase):
    r"""paths.py: Claude Desktop 데이터 디렉토리 해석 (설치 방식별 겸용).
      Win32 설치본 :  %APPDATA%\Claude
      MSIX/Store  :  %LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude
    두 후보를 모두 프로브해 '실제 존재하며 config 가 최신인' 쪽을 고른다."""

    def setUp(self):
        if SRC not in sys.path:
            sys.path.insert(0, SRC)
        import paths
        self.paths = paths
        self.tmp = tempfile.mkdtemp(prefix="paths_test_")
        self.appdata = os.path.join(self.tmp, "Roaming")
        self.localappdata = os.path.join(self.tmp, "Local")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _win32_dir(self):
        return os.path.join(self.appdata, "Claude")

    def _msix_dir(self):
        return os.path.join(self.localappdata, "Packages",
                            "Claude_pzs8sxrjxfjjc", "LocalCache", "Roaming", "Claude")

    def _make_config(self, d, mtime=None):
        os.makedirs(d, exist_ok=True)
        cfg = os.path.join(d, "claude_desktop_config.json")
        with open(cfg, "w", encoding="utf-8") as f:
            json.dump({"mcpServers": {}}, f)
        if mtime is not None:
            os.utime(cfg, (mtime, mtime))
        return cfg

    def _resolve(self):
        return self.paths.resolve_desktop_dir(appdata=self.appdata, localappdata=self.localappdata)

    def test_win32_only(self):
        self._make_config(self._win32_dir())
        self.assertEqual(self._resolve(), self._win32_dir())

    def test_msix_only(self):
        # Win32 후보 디렉토리는 아예 없고 MSIX 패키지 폴더에만 config 존재.
        self._make_config(self._msix_dir())
        self.assertEqual(self._resolve(), self._msix_dir())

    def test_both_prefers_most_recent_config(self):
        self._make_config(self._win32_dir(), mtime=1000)
        self._make_config(self._msix_dir(), mtime=2000)      # MSIX 가 더 최신 -> MSIX
        self.assertEqual(self._resolve(), self._msix_dir())
        os.utime(os.path.join(self._win32_dir(), "claude_desktop_config.json"), (3000, 3000))
        self.assertEqual(self._resolve(), self._win32_dir())  # Win32 가 최신 -> Win32

    def test_none_falls_back_to_win32(self):
        # 아무 후보도 없으면 Win32 기본 경로로 결정적 폴백(존재하지 않아도).
        self.assertEqual(self._resolve(), self._win32_dir())

    def test_desktop_config_path_appends_filename(self):
        self._make_config(self._msix_dir())
        self.assertEqual(
            self.paths.desktop_config_path(appdata=self.appdata, localappdata=self.localappdata),
            os.path.join(self._msix_dir(), "claude_desktop_config.json"))


class ClaudeConfigDump(unittest.TestCase):
    def test_report_does_not_let_a_card_value_close_the_script_tag(self):
        # Report 는 상태 JSON 을 <script> 안에 굽는다. json.dumps 는 '<' 를 이스케이프하지
        # 않으므로 description 안의 "</script>" 가 태그를 닫고 뒤가 HTML 로 파싱됐다 -
        # 그 값은 마켓/플러그인/claude.ai 에서 온 원격 저작물이다.
        if SRC not in sys.path:
            sys.path.insert(0, SRC)
        import claude_config
        payload = "</script><img src=x onerror=alert(1)>"
        html = claude_config.make_html({
            "generated": "t", "sources": {},
            "sections": [{"title": "S", "source": "f", "cards": [
                {"name": "evil", "badge": "", "ok": False, "kv": [["desc", payload]]}]}],
        })
        self.assertNotIn("</script><img", html)
        self.assertIn("\\u003c/script\\u003e", html)
        # 스크립트 블록은 템플릿이 닫는 그 하나뿐이어야 한다.
        self.assertEqual(html.count("</script>"), 1)

    def test_dump_no_unicode_crash(self):
        # 핵심 회귀 가드: PYTHONUTF8/IOENCODING 없이도(=스크립트 내 reconfigure) 죽지 않아야.
        env = {k: v for k, v in os.environ.items() if k not in ("PYTHONUTF8", "PYTHONIOENCODING")}
        p = subprocess.run([sys.executable, CFG, "dump"], capture_output=True, env=env,
                           timeout=60)
        self.assertEqual(p.returncode, 0,
                         f"dump 가 종료코드 {p.returncode} (cp949 회귀?): {p.stderr.decode('utf-8','replace')[-400:]}")
        data = json.loads(p.stdout.decode("utf-8"))
        self.assertIn("sections", data)

    def test_null_values_do_not_crash_dump(self):
        # 회귀: 손편집으로 남은 null 하나(서버 항목/args/permissions/hooks)에 dump 전체가 죽어
        # 카드 하나가 아니라 대시보드가 통째로 안 떴다. null 은 빈 값으로 다뤄야 한다.
        tmp = tempfile.mkdtemp(prefix="null_test_")
        try:
            dc = os.path.join(tmp, "desktop.json")
            with open(dc, "w", encoding="utf-8") as f:
                json.dump({"mcpServers": {"dead": None,
                                          "noargs": {"command": "npx", "args": None, "env": None}}}, f)
            st = os.path.join(tmp, "settings.json")
            with open(st, "w", encoding="utf-8") as f:
                json.dump({"permissions": None, "hooks": None}, f)
            p = subprocess.run([sys.executable, CFG, "dump", "--paths",
                                f"desktop_config={dc}", f"code_settings={st}"],
                               capture_output=True, text=True, encoding="utf-8", timeout=60)
            self.assertEqual(p.returncode, 0, f"null 값에 dump 가 죽음: {p.stderr[-400:]}")
            data = json.loads(p.stdout)
            mcp = next(s for s in data["sections"] if s["title"].startswith("MCP Servers (desktop)"))
            self.assertIn("dead", [c["name"] for c in mcp["cards"]])
        finally:
            import shutil; shutil.rmtree(tmp, ignore_errors=True)

    def test_broken_settings_surfaces_parse_error(self):
        # 회귀: 파싱 실패를 빈 목록으로 렌더하면 '규칙이 사라졌다'고 오인하게 된다.
        # (같은 파일의 .mcp.json 렌더러는 이미 오류 카드를 띄우고 있었다 - 동작을 맞춘다.)
        tmp = tempfile.mkdtemp(prefix="broken_test_")
        try:
            st = os.path.join(tmp, "settings.json")
            with open(st, "w", encoding="utf-8") as f:
                f.write('{"permissions": {"allow": ["Bash(ls)"],,}}')   # 문법 오류
            p = subprocess.run([sys.executable, CFG, "dump", "--paths", f"code_settings={st}"],
                               capture_output=True, text=True, encoding="utf-8", timeout=60)
            self.assertEqual(p.returncode, 0, p.stderr)
            sec = next(s for s in json.loads(p.stdout)["sections"]
                       if s["title"].startswith("Permissions"))
            self.assertTrue(sec["cards"], "깨진 settings 가 '규칙 없음'으로 조용히 표시됨")
            self.assertTrue(any("오류" in c["name"] for c in sec["cards"]),
                            f"파싱 오류 카드가 없음: {[c['name'] for c in sec['cards']]}")
        finally:
            import shutil; shutil.rmtree(tmp, ignore_errors=True)

    def test_projects_has_claude_flag(self):
        # .claude.json projects -> {path,name,claude_dir,has_claude}. .claude 있는 것만 True.
        tmp = tempfile.mkdtemp(prefix="proj_test_")
        try:
            pa = os.path.join(tmp, "projA"); os.makedirs(os.path.join(pa, ".claude"))
            pb = os.path.join(tmp, "projB"); os.makedirs(pb)  # .claude 없음
            cj = os.path.join(tmp, ".claude.json")
            with open(cj, "w", encoding="utf-8") as f:
                json.dump({"projects": {pa: {}, pb: {}}}, f)
            p = subprocess.run([sys.executable, CFG, "projects", "--paths", f"claude_json={cj}"],
                               capture_output=True, text=True, encoding="utf-8", timeout=60)
            self.assertEqual(p.returncode, 0, p.stderr)
            by = {x["path"]: x for x in json.loads(p.stdout)["projects"]}
            self.assertTrue(by[pa]["has_claude"])
            self.assertFalse(by[pb]["has_claude"])
            self.assertEqual(by[pa]["claude_dir"], os.path.join(pa, ".claude"))
        finally:
            import shutil; shutil.rmtree(tmp, ignore_errors=True)

    def test_projects_dedup_same_dir_different_spelling(self):
        # 회귀: Claude Code 가 세션 CWD 표기 그대로 키를 쌓아 같은 폴더가 여러 키로 남는다
        # (d:/x, D:/x, D:\x). 그대로 나열하면 '프로젝트에서 추가' 목록에 같은 폴더가 중복 표시됐다.
        tmp = tempfile.mkdtemp(prefix="dedup_test_")
        try:
            pa = os.path.join(tmp, "projA"); os.makedirs(os.path.join(pa, ".claude"))
            variants = [pa, pa + os.sep, os.path.join(pa, ".")]
            if os.name == "nt":
                variants += [pa.replace("\\", "/"), pa.upper()]
            cj = os.path.join(tmp, ".claude.json")
            with open(cj, "w", encoding="utf-8") as f:
                json.dump({"projects": {v: {} for v in variants}}, f)
            p = subprocess.run([sys.executable, CFG, "projects", "--paths", f"claude_json={cj}"],
                               capture_output=True, text=True, encoding="utf-8", timeout=60)
            self.assertEqual(p.returncode, 0, p.stderr)
            rows = json.loads(p.stdout)["projects"]
            self.assertEqual(len(rows), 1, f"중복 표기가 그대로 나열됨: {[r['path'] for r in rows]}")
            self.assertEqual(rows[0]["path"], pa, "먼저 나온 표기를 살려야 함")
            self.assertTrue(rows[0]["has_claude"])
        finally:
            import shutil; shutil.rmtree(tmp, ignore_errors=True)

    def test_agents_scanned_recursively(self):
        # Claude 는 하위 폴더의 에이전트까지 읽는다. 한 단계만 보면 있는 것을 없다고 표시함.
        # 동시에 .trash(삭제 보관분)는 어느 깊이에서도 살아있는 항목으로 나오면 안 되고,
        # 중첩 항목은 제거 op 가 단일 세그먼트 이름만 받으므로 편집 미부여여야 한다.
        tmp = tempfile.mkdtemp(prefix="agents_test_")
        try:
            ad = os.path.join(tmp, "agents")
            os.makedirs(os.path.join(ad, "review"))
            os.makedirs(os.path.join(ad, ".trash"))
            for rel, nm in (("top.md", "top-agent"),
                            (os.path.join("review", "security.md"), "sec-review"),
                            (os.path.join(".trash", "deleted.md"), "trashed-agent")):
                with open(os.path.join(ad, rel), "w", encoding="utf-8") as f:
                    f.write(f"---\nname: {nm}\ndescription: d\n---\n")
            p = subprocess.run([sys.executable, CFG, "dump", "--paths", f"agents_dir={ad}"],
                               capture_output=True, text=True, encoding="utf-8", timeout=60)
            self.assertEqual(p.returncode, 0, p.stderr)
            sec = next(s for s in json.loads(p.stdout)["sections"] if s["title"].startswith("Agents"))
            by = {c["name"]: c for c in sec["cards"]}
            self.assertIn("sec-review", by, "하위 폴더 에이전트가 안 보임(재귀 회귀)")
            self.assertIn("top-agent", by)
            self.assertNotIn("trashed-agent", by, ".trash 항목이 살아있는 카드로 노출됨")
            self.assertIsNone(by["sec-review"].get("edit"), "중첩 항목에 편집이 붙음(제거 op 가 못 받는 이름)")
            self.assertEqual((by["top-agent"].get("edit") or {}).get("name"), "top")
        finally:
            import shutil; shutil.rmtree(tmp, ignore_errors=True)

    def test_project_commands_and_mcp_json(self):
        # commands 는 하위 폴더가 네임스페이스(재귀), .mcp.json 은 프로젝트 스코프 MCP.
        # 둘 다 제거 op 가 없어 뷰 전용이어야 하고, env 는 값 없이 키 이름만 나가야 한다.
        tmp = tempfile.mkdtemp(prefix="t2_test_")
        try:
            cdir = os.path.join(tmp, ".claude")
            os.makedirs(os.path.join(cdir, "commands", "frontend"))
            os.makedirs(os.path.join(cdir, "commands", ".trash"))
            for rel in ("deploy.md", os.path.join("frontend", "component.md"),
                        os.path.join(".trash", "old.md")):
                with open(os.path.join(cdir, "commands", rel), "w", encoding="utf-8") as f:
                    f.write("---\ndescription: d\n---\n")
            with open(os.path.join(tmp, ".mcp.json"), "w", encoding="utf-8") as f:
                json.dump({"mcpServers": {"team-db": {"command": "npx",
                                                      "env": {"DB_TOKEN": "SECRET_VALUE"}}}}, f)
            p = subprocess.run([sys.executable, CFG, "dump", "--projects", cdir],
                               capture_output=True, text=True, encoding="utf-8", timeout=60)
            self.assertEqual(p.returncode, 0, p.stderr)
            self.assertNotIn("SECRET_VALUE", p.stdout, "env 값이 dump 로 샘")
            data = json.loads(p.stdout)
            cmds = next(s for s in data["sections"] if s["title"].startswith("Commands"))
            names = {c["name"] for c in cmds["cards"]}
            self.assertIn("frontend/component", names, "네임스페이스 커맨드가 안 보임(재귀 회귀)")
            self.assertIn("deploy", names)
            self.assertNotIn(".trash/old", names)
            self.assertTrue(all(c.get("edit") is None for c in cmds["cards"]), "commands 는 제거 op 가 없음")
            mcp = next(s for s in data["sections"] if s["title"].startswith("MCP Servers (project)"))
            self.assertEqual([c["name"] for c in mcp["cards"]], ["team-db"])
            self.assertEqual(dict(mcp["cards"][0]["kv"])["env"], "DB_TOKEN")
        finally:
            import shutil; shutil.rmtree(tmp, ignore_errors=True)

    def test_settings_local_merged_as_separate_source(self):
        # settings.local.json 은 settings.json 과 함께 적용된다(local 우선). first_existing 으로
        # 하나만 읽으면 실제 적용 중인 규칙이 안 보인다. 두 파일이 각각 출처로 나오고,
        # 각 카드의 편집 대상(edit.settings)이 자기 파일이어야 한다(엉뚱한 파일 편집 방지).
        tmp = tempfile.mkdtemp(prefix="settings_test_")
        try:
            base = os.path.join(tmp, "settings.json")
            local = os.path.join(tmp, "settings.local.json")
            with open(base, "w", encoding="utf-8") as f:
                json.dump({"permissions": {"allow": ["Bash(ls:*)"]}}, f)
            with open(local, "w", encoding="utf-8") as f:
                json.dump({"permissions": {"allow": ["Bash(git:*)", "Read(*)"]}}, f)
            p = subprocess.run([sys.executable, CFG, "dump", "--paths", f"code_settings={base}"],
                               capture_output=True, text=True, encoding="utf-8", timeout=60)
            self.assertEqual(p.returncode, 0, p.stderr)
            sec = next(s for s in json.loads(p.stdout)["sections"]
                       if s["title"].startswith("Permissions"))
            allows = [c for c in sec["cards"] if c["name"] == "allow"]
            by_src = {c["source"]: c for c in allows}
            self.assertIn(local, by_src, "settings.local.json 이 안 보임(적용되는데 미표시)")
            self.assertIn(base, by_src)
            self.assertEqual(by_src[local]["edit"]["items"], ["Bash(git:*)", "Read(*)"])
            self.assertEqual(by_src[base]["edit"]["items"], ["Bash(ls:*)"])
            # 편집이 자기 파일로 가는지: local 카드가 settings.json 을 건드리면 안 된다.
            for f_path, c in by_src.items():
                self.assertEqual(c["edit"]["settings"], f_path)
        finally:
            import shutil; shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
