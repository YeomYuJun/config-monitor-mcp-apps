// src/ui/state.ts - 화면 전역 상태. **아무것도 import 하지 않는다** - 렌더를 부르지 않으므로
// state -> 렌더 -> state 순환이 생길 수 없다. libSelBarUpdate 같은 콜백 훅도 여기 담기만 하고
// 등록·호출은 렌더 쪽이 한다.
// 읽기는 ESM 라이브 바인딩 그대로다(import 한 이름은 항상 현재 값). 밖에서 막히는 건 대입뿐이라
// 바뀌는 값에만 setter 를 둔다 - const Set/Record 는 .add()/.delete() 라 setter 가 필요 없다.
export let selectedPath = "";
export let currentRevs: any[] = [];
export let fromRev = "";
export let toRev = "work";
// 기동 시 닫힘. 파일을 고르기 전에는 패널에 보여줄 게 없다(selectFile 이 열어 준다).
export let detailOpen = false;
// 기동 시 전 섹션 접힘. Library/Marketplace 는 renderConfig 이후에 그려져 아래 collapsedInit
// 루프가 못 잡으므로 여기서 미리 넣어 둔다(사용자가 펼치면 그 상태가 세션 내내 유지된다).
export const collapsed = new Set<string>(["library", "marketplace"]);   // 접힌 섹션 id
// Claude Code 쪽 상태 캐시. 카탈로그 행이 "이 플러그인을 통째로 설치할 수 있는가"를 판정한다.
//   ccPlugins  이미 Claude Code 에 설치된 플러그인 id (renderConfig 이 Plugins 카드에서 채움)
//   ccMarkets  Claude Code 가 아는 마켓 이름 (buildCatalog 이 market-discover 로 채움).
//              여기 없는 마켓의 플러그인은 `claude plugin install` 이 찾지 못한다 - 먼저
//              저쪽에 마켓을 등록해야 하므로 버튼을 비활성화하고 이유를 표시한다.
export const ccPlugins = new Set<string>();
export const ccMarkets = new Set<string>();
// Claude Code 가 미리 계산해 캐시해 둔 인벤토리 {id: {installs, components:{kind:n}, total}}.
// 이게 있으면 **fetch 하기 전에** "무엇이 설치되는지"를 말할 수 있다. 공식 마켓 전용이라
// 없는 행도 정상이다 - 그 경우 개수를 숨긴다(0 이라고 말하지 않는다. 모르는 것이다).
export let ccCatalog: Record<string, any> = {};
// 추적 중인 프로젝트 경로. claude 는 scope=project/local 을 **cwd 로** 정하므로 설치 대상을
// 고르려면 이 목록이 필요하다(스코프 칩과 같은 원천 - renderConfig 이 채운다).
export let knownProjects: string[] = [];
// config-monitor 스토어에 등록된 마켓 URL(정규화). 공식 마켓 프리셋을 이미 등록된 상태에서
// 다시 권하지 않기 위해서만 쓴다.
export const cmMarketUrls = new Set<string>();
// URL 이 없는 스토어 마켓(로컬 경로로 등록된 것 - marketplace.py 의 kind local/str-path 는
// url:None 이다). 이런 마켓은 헤더에 'Claude Code 등록' 버튼이 아예 안 그려지므로,
// 카탈로그 행의 비활성 사유가 그 버튼을 가리키면 없는 것을 가리키게 된다.
// **없는 쪽을 모은다**: 이름을 못 찾으면 기본(버튼을 가리키는) 문구로 떨어져 기존 동작이 된다.
export const cmMarketsNoUrl = new Set<string>();
// Claude Code 가 기본 내장하는 마켓. 처음 쓰는 사람에게 카탈로그가 텅 빈 채로 보이지 않도록
// 원클릭 프리셋으로 제공한다. 자동 등록은 하지 않는다 - 등록은 네트워크를 타는 행위이고,
// "요청하지 않으면 아무것도 받지 않는다"가 이 제품의 계약이다.
export const OFFICIAL_MARKET_URL = "https://github.com/anthropics/claude-plugins-official.git";
export const normUrl = (u: string): string => {
  const s = String(u || "").trim().replace(/\/+$/, "").toLowerCase();
  return s.endsWith(".git") ? s.slice(0, -4) : s;
};
export const secIds = new Set<string>();            // 접기 가능한 섹션 id (전부 접기 대상)
export let collapsedInit = false;                    // 기본 접힘 1회만 적용
// 출처 표시 토글(스코프 필터와 독립). 기본은 둘 다 표시 - buildOriginToggles 주석 참고.
export let showPlugin = true;                        // 플러그인이 넣은 항목
export let showBuiltin = true;                       // 기본 제공(Desktop Skills creatorType=anthropic)
// 루트(폴더 없는) 항목 묶음의 예약 키. 폴더 경로에는 ':' 가 들어갈 수 없어 실제 경로와 겹치지 않는다.
export const ROOT_GROUP_KEY = "::root";
// 펼친 라이브러리 스킬 그룹 경로. 폴더 그룹은 기본 접힘, 루트 묶음만 기본 펼침
// (폴더 없는 항목은 목록의 본체라 접어두면 스킬이 비어 보인다).
export const libGroupOpen = new Set<string>([ROOT_GROUP_KEY]);
export const libChecked = new Set<string>();        // 선택 설치용 체크된 항목 key(카테고리 무관)
export const libOpen = new Set<string>(["skills"]); // 펼친 카테고리(기본값: Skills 만)
export let libProjectTargets: string[] = [];        // 설치 대상 후보(추적 중인 프로젝트 .claude 경로들). renderTracked 가 매 새로고침 갱신
export let libTarget = "";                           // 선택된 라이브러리 설치 대상("" = 전역 ~/.claude, 아니면 프로젝트 .claude)
export let libSelBarUpdate: (() => void) | null = null; // 체크박스 -> 상단 "선택 설치 (N)" 카운트 갱신 훅
// 전체 재렌더 훅. refresh() 는 tracked/config/library/catalog/watcher 를 차례로 부르는 구성 루트라
// 섹션 모듈이 직접 import 하면 엔트리와 순환이 된다. 엔트리가 자기 refresh 를 여기 등록하고
// 섹션은 이것만 부른다(libSelBarUpdate 와 같은 규율).
export let refreshApp: (() => Promise<void>) | null = null;
export let scopeFilter = "all";                      // 설정 스코프 필터: 'all' | 'global' | <projectPath>
export const srcOpen: Record<string, boolean> = {};  // 출처 그룹 접힘 상태(키: `${secId}::g` | `${secId}::${project}`)
export const catOpen = new Set<string>();     // 펼친 마켓 id(기본 접힘 - 마켓 하나가 278개다)
export let catSecEl: HTMLElement | null = null; // 제자리 교체용 현재 카탈로그 섹션 노드(refresh 가 무효화한다)
export let lastConfigSections: any[] = [];           // 스코프 칩/그룹 즉시 재렌더용 최신 섹션 캐시
// 섹션 표시 설정. 스토어(store/config.json 의 ui 블록)가 정본이고 여기는 그 사본이다.
// preset 은 '어느 범주를 볼까'만, hideEmpty 는 '빈 섹션을 감출까'만 정한다. 서로 건드리지 않는다
// - 한쪽이 다른 쪽을 써주면 preset 은 X 라고 표시되는데 화면은 Y 인 상태가 저장된다.
export interface SectionPrefs {
  preset: "all" | "common" | "custom";
  hidden: string[];          // custom 에서만 의미
  hideEmpty: boolean;
  groupsCollapsed: string[];
}
export let sectionPrefs: SectionPrefs =
  { preset: "all", hidden: [], hideEmpty: true, groupsCollapsed: [] };
export const setSectionPrefs = (v: SectionPrefs): void => { sectionPrefs = v; };
// '주로 쓰는 것' 이 포함하는 그룹. 나머지(connect/memory/env)는 한 번 맞춰두면 잘 안 건드린다.
export const COMMON_GROUPS = ["instructions", "extensions", "exec"];

export const setSelectedPath       = (v: string): void => { selectedPath = v; };
export const setCurrentRevs        = (v: any[]): void => { currentRevs = v; };
export const setFromRev            = (v: string): void => { fromRev = v; };
export const setToRev              = (v: string): void => { toRev = v; };
export const setDetailOpen         = (v: boolean): void => { detailOpen = v; };
export const setCcCatalog          = (v: Record<string, any>): void => { ccCatalog = v; };
export const setKnownProjects      = (v: string[]): void => { knownProjects = v; };
export const setCollapsedInit      = (v: boolean): void => { collapsedInit = v; };
export const setShowPlugin         = (v: boolean): void => { showPlugin = v; };
export const setShowBuiltin        = (v: boolean): void => { showBuiltin = v; };
export const setLibProjectTargets  = (v: string[]): void => { libProjectTargets = v; };
export const setLibTarget          = (v: string): void => { libTarget = v; };
export const setLibSelBarUpdate    = (v: (() => void) | null): void => { libSelBarUpdate = v; };
export const setRefreshApp         = (v: (() => Promise<void>) | null): void => { refreshApp = v; };
export const setCatSecEl           = (v: HTMLElement | null): void => { catSecEl = v; };
export const setScopeFilter        = (v: string): void => { scopeFilter = v; };
export const setLastConfigSections = (v: any[]): void => { lastConfigSections = v; };
