// 시그니처 파일의 본문이 던지는 오류. 이식이 끝난 모듈은 이 import 를 지운다.
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} is not ported yet`);
    this.name = "NotImplementedError";
  }
}

export function notImplemented(what: string): never {
  throw new NotImplementedError(what);
}
