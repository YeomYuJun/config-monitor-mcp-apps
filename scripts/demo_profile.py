#!/usr/bin/env python3
r"""demo_profile.py - README 스크린샷용 데모 프로필을 만든다.

  python scripts/demo_profile.py Z:\

<root> 아래에 가짜 사용자(alex)의 Claude 설정, 추적 프로젝트 하나, 라이브러리, 스냅샷 이력,
다른 PC 에서 만든 이관 번들을 만든다. 실제 설정은 건드리지 않는다. 화면 경로가 짧고 사람 이름이
드러나지 않게, 빈 드라이브 글자에 임시 폴더를 subst 로 붙여 그 루트를 넘기는 것을 권한다.

끝에 대시보드를 이 프로필로 띄우는 환경변수를 출력한다(브라우저 모드: npm run serve).
"""
import json, os, shutil, subprocess, sys

SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src")


def write(p, text):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write(text if isinstance(text, str) else json.dumps(text, indent=2))


def md(desc, body="", **front):
    head = "".join(f"{k}: {v}\n" for k, v in front.items())
    return f"---\ndescription: {desc}\n{head}---\n\n{body}\n"


def env_for(home, store, libs=""):
    return dict(os.environ, HOME=home, USERPROFILE=home, CLAUDE_SNAPSHOT_STORE=store,
                APPDATA=os.path.join(home, "AppData", "Roaming"),
                LOCALAPPDATA=os.path.join(home, "AppData", "Local"),
                CLAUDE_CONFIG_LIBRARIES=libs, CLAUDE_CAS_NO_DEFAULT_TRACK="0")


def py(script, env, *args):
    r = subprocess.run([sys.executable, os.path.join(SRC, script), *args], env=env,
                       capture_output=True, text=True, encoding="utf-8")
    if r.returncode:
        raise SystemExit(f"{script} {' '.join(args)}\n{r.stdout}\n{r.stderr}")
    return r.stdout


def node(path):
    return f'node "{path}"'


def library(lib):
    """my-tools 모양의 개인 라이브러리: .claude 구조 + 훅·MCP 도구."""
    write(os.path.join(lib, "skills", "release-notes", "SKILL.md"), md("Draft release notes from merged PRs"))
    write(os.path.join(lib, "skills", "sql-review", "SKILL.md"), md("Review SQL migrations for locking and data loss"))
    write(os.path.join(lib, "skills", "api-docs", "SKILL.md"), md("Generate endpoint docs from route handlers"))
    write(os.path.join(lib, "agents", "test-writer.md"), md("Writes focused unit tests for a changed file", name="test-writer"))
    write(os.path.join(lib, "agents", "security-auditor.md"), md("Audits a diff for injection and secret leaks", name="security-auditor"))
    write(os.path.join(lib, "commands", "standup.md"), md("Summarize yesterday's commits for standup"))
    # 도구 폴더마다 플러그인과 같은 선언 파일을 둬 Library 의 Hooks·MCP 단위로 잡히게 한다.
    for h, event, matcher in (("format-on-save", "PostToolUse", "Edit|Write"), ("guard-secrets", "PreToolUse", "Bash"),
                              ("lint", "Stop", None)):
        d = os.path.join(lib, "hooks", h)
        write(os.path.join(d, "index.js"), "// demo hook\n")
        entry = {"hooks": [{"type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/index.js"}]}
        if matcher:
            entry["matcher"] = matcher
        write(os.path.join(d, "hooks", "hooks.json"), {"hooks": {event: [entry]}})
    srv = os.path.join(lib, "servers", "notes")
    write(os.path.join(srv, "server.js"), "// demo MCP server\n")
    write(os.path.join(srv, ".mcp.json"),
          {"mcpServers": {"notes": {"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/server.js"]}}})


def user_home(home, lib, project):
    ch = os.path.join(home, ".claude")
    hooks = os.path.join(lib, "hooks")
    write(os.path.join(ch, "CLAUDE.md"), "# Working style\n\n- Prefer small, reviewed changes.\n")
    for name, desc in [("code-review", "Review a diff for correctness and readability"),
                       ("changelog", "Keep CHANGELOG.md in step with releases"),
                       ("release-notes", "Draft release notes from merged PRs"),
                       ("debug-trace", "Trace a failing request through the logs")]:
        write(os.path.join(ch, "skills", name, "SKILL.md"), md(desc))
    for name, desc in [("planner", "Breaks a feature into reviewable steps"),
                       ("test-writer", "Writes focused unit tests for a changed file"),
                       ("doc-editor", "Tightens README and docs prose")]:
        write(os.path.join(ch, "agents", f"{name}.md"), md(desc, name=name, tools="Read, Grep, Edit"))
    write(os.path.join(ch, "commands", "standup.md"), md("Summarize yesterday's commits for standup"))
    write(os.path.join(ch, "commands", "triage.md"), md("Label and route new issues"))
    write(os.path.join(ch, "rules", "style.md"), md("House style for TypeScript"))
    write(os.path.join(ch, "rules", "sql.md"), md("Migration rules", paths="migrations/**"))
    write(os.path.join(ch, "output-styles", "concise.md"), md("Short answers, code first"))
    write(os.path.join(ch, "settings.json"), {
        "model": "sonnet",
        "outputStyle": "concise",
        "permissions": {"allow": ["Read", "Bash(git status)", "Bash(git diff:*)"], "deny": ["Read(./.env)"]},
        "hooks": {
            "PostToolUse": [{"matcher": "Edit|Write", "hooks": [
                {"type": "command", "command": node(os.path.join(hooks, "format-on-save", "index.js"))}]}],
            "PreToolUse": [{"matcher": "Bash", "hooks": [
                {"type": "command", "command": node(os.path.join(hooks, "guard-secrets", "index.js"))}]}],
        },
    })
    write(os.path.join(home, ".claude.json"), {
        "mcpServers": {
            "github": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"]},
            "notes": {"command": "node", "args": [os.path.join(lib, "servers", "notes", "server.js")]},
        },
        "projects": {project.replace("\\", "/"): {"allowedTools": ["Bash(npm test)"], "hasTrustDialogAccepted": True}},
    })
    write(os.path.join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json"), {
        "mcpServers": {
            "filesystem": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", project]},
            "notes": {"command": "node", "args": [os.path.join(lib, "servers", "notes", "server.js")]},
        }})


def project_dir(project):
    pc = os.path.join(project, ".claude")
    write(os.path.join(project, "CLAUDE.md"), "# acme-web\n\nNext.js app. Run `npm test` before pushing.\n")
    write(os.path.join(pc, "settings.json"), {"permissions": {"allow": ["Bash(npm test)", "Bash(npm run lint)"]}})
    write(os.path.join(pc, "skills", "deploy-preview", "SKILL.md"), md("Deploy a preview build for this branch"))
    write(os.path.join(pc, "agents", "planner.md"), md("Plans work against this repo's conventions", name="planner"))
    write(os.path.join(project, ".mcp.json"), {"mcpServers": {"postgres": {"command": "npx", "args": ["-y", "pg-mcp"]}}})


def history(home, store, project, libs):
    """설정 파일마다 diff 가 보이는 리비전 몇 개 + 마지막에는 스냅샷 밖에서 고친 변경 하나."""
    env = env_for(home, store, libs)
    sp = os.path.join(home, ".claude", "settings.json")
    py("cas.py", env, "--store", store, "init")
    py("cas.py", env, "--store", store, "track", project)
    py("cas.py", env, "--store", store, "snapshot", "-m", "initial setup")
    for msg, fn in [
        ("allow npm test", lambda s: s["permissions"]["allow"].append("Bash(npm test)")),
        ("deny reading secrets", lambda s: s["permissions"]["deny"].append("Read(./secrets/**)")),
        ("switch model", lambda s: s.update(model="opus")),
    ]:
        with open(sp, encoding="utf-8") as f:
            s = json.load(f)
        fn(s)
        write(sp, s)
        py("cas.py", env, "--store", store, "snapshot", "-m", msg)
    pp = os.path.join(project, ".claude", "settings.json")
    with open(pp, encoding="utf-8") as f:
        s = json.load(f)
    s["permissions"]["allow"].append("Bash(npx playwright test)")
    write(pp, s)                                     # 스냅샷 밖 변경 - 목록에 '수정' 으로 보인다


def old_pc_bundle(root, bundle):
    """다른 PC(sam, 도구는 그 PC 의 old-drive)에서 만든 번들. 만든 뒤 그 PC 폴더는 지운다."""
    old = os.path.join(root, "old-pc")
    home = os.path.join(old, "Users", "sam")
    lib = os.path.join(old, "old-drive", "my-tools")
    store = os.path.join(home, ".claude-snapshot")
    library(lib)
    write(os.path.join(lib, "hooks", "notify", "index.js"), "// only on the old PC\n")
    ch = os.path.join(home, ".claude")
    hooks = os.path.join(lib, "hooks")
    for name, desc in [("code-review", "Review a diff for correctness and readability"),
                       ("sql-review", "Review SQL migrations for locking and data loss"),
                       ("api-docs", "Generate endpoint docs from route handlers")]:
        write(os.path.join(ch, "skills", name, "SKILL.md"), md(desc))
    write(os.path.join(ch, "agents", "security-auditor.md"), md("Audits a diff for injection and secret leaks", name="security-auditor"))
    write(os.path.join(ch, "settings.json"), {
        "model": "opus",
        "permissions": {"allow": ["Read", "Bash(git status)", "Bash(pytest:*)"]},
        "hooks": {
            "PostToolUse": [{"matcher": "Edit|Write", "hooks": [
                {"type": "command", "command": node(os.path.join(hooks, "format-on-save", "index.js"))}]}],
            "Stop": [{"hooks": [{"type": "command", "command": node(os.path.join(hooks, "notify", "index.js"))},
                                {"type": "command", "command": node(os.path.join(hooks, "lint", "index.js"))}]}],
            "PreToolUse": [{"matcher": "Bash", "hooks": [
                {"type": "command", "command": node(os.path.join(hooks, "guard-secrets", "index.js"))}]}],
        },
    })
    write(os.path.join(home, ".claude.json"), {"mcpServers": {
        "notes": {"command": "node", "args": [os.path.join(lib, "servers", "notes", "server.js")]},
        "jira": {"command": "node", "args": [os.path.join(old, "old-drive", "jira-mcp", "index.js")]},
    }})
    write(os.path.join(store, "config.json"), {"version": 1, "store": store, "tracked": [], "libraries": [lib]})
    py("transfer.py", env_for(home, store), "--store", store, "export", "--out", bundle)
    mp = os.path.join(bundle, "manifest.json")
    with open(mp, encoding="utf-8") as f:
        m = json.load(f)
    m["source"]["host"] = "old-laptop"               # 이 PC 의 호스트명이 화면에 찍히지 않게
    write(mp, m)
    shutil.rmtree(old)


def main():
    root = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "demo")
    home = os.path.join(root, "Users", "alex")
    lib = os.path.join(root, "tools", "my-tools")
    project = os.path.join(root, "work", "acme-web")
    store = os.path.join(home, ".claude-snapshot")
    bundle = os.path.join(root, "bundles", "old-laptop")
    for d in (os.path.join(root, "Users"), os.path.join(root, "tools"), os.path.join(root, "work"),
              os.path.join(root, "bundles"), os.path.join(root, "old-pc")):
        shutil.rmtree(d, ignore_errors=True)
    library(lib)
    user_home(home, lib, project)
    project_dir(project)
    history(home, store, project, lib)
    old_pc_bundle(root, bundle)
    print("# 데모 프로필로 대시보드 띄우기 (PowerShell)")
    for k, v in [("HOME", home), ("USERPROFILE", home), ("APPDATA", os.path.join(home, "AppData", "Roaming")),
                 ("LOCALAPPDATA", os.path.join(home, "AppData", "Local")), ("CLAUDE_SNAPSHOT_STORE", store),
                 ("CLAUDE_CONFIG_LIBRARIES", lib), ("CONFIG_MONITOR_LANG", "en")]:
        print(f"$env:{k} = '{v}'")
    print("npm run serve   # 이관 화면: 가져오기 탭에 " + bundle)


if __name__ == "__main__":
    main()
