// paths.ts - Claude Desktop 데이터 디렉토리 해석 (Win32 + MSIX/Store 겸용). src/paths.py 이식.
//
// Claude Desktop 의 설정(claude_desktop_config.json)과 skills-plugin manifest 는
// "설치 방식"에 따라 서로 다른 물리 경로에 존재한다:
//
//   Win32 설치본(Claude-Setup.exe)  :  %APPDATA%\Claude
//   MSIX/Store 설치본               :  %LOCALAPPDATA%\Packages\Claude_<hash>\LocalCache\Roaming\Claude
//
// MSIX 의 LocalCache 폴더는 "가상화된 %APPDATA%" 지만, 그 물리 경로 자체는 어떤 프로세스에서도
// 직접 읽을 수 있는 실제 폴더다. 두 후보를 모두 실제 경로로 프로브하면, config-monitor 가 Desktop 의
// 자식으로 실행될 때 AppData 리다이렉트가 자식 프로세스에 적용되는지와 무관하게 올바른 파일을 찾는다.
//
// read(claude_config) 와 write(config_edit) 가 반드시 "같은 파일"을 대상으로 삼도록,
// 경로 해석은 이 모듈 한 곳에서만 한다(드리프트 방지).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DESKTOP_CONFIG_NAME = "claude_desktop_config.json";

// ~/.claude/skills 아래의 예약 폴더. claude.ai 계정 스킬이 내려오는 자리라 사용자 스킬이 아니고,
// 편집해도 다음 동기화가 덮는다. 프로젝트 .claude/skills 에서는 예약어가 아니다.
export const RESERVED_SKILL_DIRS: readonly string[] = ["synced"];

/**
 * Python os.path.expanduser 와 같은 규칙. 환경변수는 호출 시점에 읽는다.
 * Windows: USERPROFILE, 없으면 HOMEDRIVE+HOMEPATH, 둘 다 없으면 입력 그대로. 그 밖: HOME, 없으면 os.homedir().
 */
export function expanduser(p: string): string {
  if (!p.startsWith("~")) return p;
  const win = process.platform === "win32";
  const seps = win ? ["/", "\\"] : ["/"];
  let i = 1;
  while (i < p.length && !seps.includes(p[i])) i++;
  if (i !== 1) return p;   // ~user 형식은 쓰지 않는다
  let home: string | undefined;
  if (win) {
    const env = process.env;
    if (env.USERPROFILE !== undefined) home = env.USERPROFILE;
    else if (env.HOMEPATH !== undefined) home = (env.HOMEDRIVE ?? "") + env.HOMEPATH;
    else return p;
  } else {
    // os.homedir 는 HOME 이 없을 때 passwd 항목을 본다(Python 의 pwd 폴백과 같다).
    home = (process.env.HOME ?? os.homedir()).replace(/\/+$/, "") || "/";
  }
  return home + p.slice(i);
}

/** os.environ.get(key, default): 빈 문자열은 값으로 본다. */
function envDefault(key: string, home: string, ...tail: string[]): string {
  const v = process.env[key];
  return v !== undefined ? v : path.join(home, ...tail);
}

function lexists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Packages\Claude_* 글롭. Python glob 은 Windows 에서 대소문자를 무시하고 결과를 sorted() 로 정렬한다. */
function msixCandidates(localappdata: string): string[] {
  const pkgs = path.join(localappdata, "Packages");
  let names: string[];
  try {
    names = fs.readdirSync(pkgs);
  } catch {
    return [];
  }
  const re = process.platform === "win32" ? /^claude_/i : /^Claude_/;
  return names
    .filter((n) => re.test(n) && !n.startsWith("."))
    .map((n) => path.join(pkgs, n, "LocalCache", "Roaming", "Claude"))
    .filter(lexists)
    .sort(comparePy);
}

function comparePy(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Claude Desktop 데이터 디렉토리('...\Claude') 후보를 우선순위 순으로 반환.
 * 존재 여부와 무관하게 경로 문자열만 만든다(Win32 먼저, 그다음 발견된 MSIX 패키지들).
 * appdata/localappdata/home 을 넘기면 env 대신 그 값을 쓴다(테스트/명시 지정용).
 */
export function desktopDirCandidates(appdata?: string | null, localappdata?: string | null, home?: string | null): string[] {
  const h = home || expanduser("~");
  const ad = appdata || envDefault("APPDATA", h, "AppData", "Roaming");
  const lad = localappdata || envDefault("LOCALAPPDATA", h, "AppData", "Local");
  // 패키지 패밀리 해시는 게시자 기준 고정이지만 버전/재설치에 견고하도록 글롭으로 탐색한다.
  return [path.join(ad, "Claude"), ...msixCandidates(lad)];
}

function configMtime(d: string): number | null {
  try {
    return fs.statSync(path.join(d, DESKTOP_CONFIG_NAME)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * 실제 Claude Desktop 디렉토리를 해석한다.
 *  1) config 파일이 존재하는 후보 중 config mtime 이 가장 최신인 것
 *     (A/B 가 모두 있는 재설치·마이그레이션 상황에서 '지금 쓰이는' 파일 우선. 동률이면 앞 후보)
 *  2) 없으면 디렉토리라도 존재하는 후보 중 첫 번째
 *  3) 아무것도 없으면 첫 후보(Win32 기본). 결정적 폴백
 */
export function resolveDesktopDir(appdata?: string | null, localappdata?: string | null, home?: string | null): string {
  const cands = desktopDirCandidates(appdata, localappdata, home);
  let best: string | null = null;
  let bestM = -Infinity;
  for (const c of cands) {
    const m = configMtime(c);
    if (m !== null && m > bestM) {
      best = c;
      bestM = m;
    }
  }
  if (best !== null) return best;
  for (const c of cands) if (isDir(c)) return c;
  return cands[0];
}

/** 해석된 Claude Desktop 디렉토리 하위의 claude_desktop_config.json 절대경로. */
export function desktopConfigPath(appdata?: string | null, localappdata?: string | null, home?: string | null): string {
  return path.join(resolveDesktopDir(appdata, localappdata, home), DESKTOP_CONFIG_NAME);
}

/** 진단용(paths.py 의 __main__): 어떤 후보가 잡히고 무엇이 선택되는지. */
export function diagnostics(): {
  candidates: { dir: string; dir_exists: boolean; config_exists: boolean }[];
  resolved_dir: string;
  resolved_config: string;
} {
  return {
    candidates: desktopDirCandidates().map((c) => ({
      dir: c,
      dir_exists: isDir(c),
      config_exists: fs.existsSync(path.join(c, DESKTOP_CONFIG_NAME)),
    })),
    resolved_dir: resolveDesktopDir(),
    resolved_config: desktopConfigPath(),
  };
}
