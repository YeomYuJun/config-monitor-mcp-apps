"""cli_result.py - runPy 로 불리는 스크립트의 stdout 계약.

stdout 에는 JSON 문서 하나: {ok, code, message, [target], [detail], <도구별 필드>}.
ok:true 는 exit 0, ok:false 는 exit 1. code 가 UI 분기와 번역의 유일한 기준이다.
"""
import argparse, json, sys, traceback

RESERVED = frozenset({"ok", "code", "message", "target", "detail"})


def check_fields(fields):
    """도구별 필드가 예약 키를 덮지 못하게 한다(레코드를 최상위로 펴는 호출부용)."""
    clash = RESERVED & set(fields)
    if clash:
        raise ValueError(f"예약 키와 충돌하는 필드: {sorted(clash)}")
    return fields


def emit(ok, code, message, *, target=None, detail=None, indent=None, **fields):
    doc = {"ok": bool(ok), "code": code, "message": message}
    if target is not None:
        doc["target"] = str(target)
    if detail is not None:
        doc["detail"] = str(detail)
    doc.update(check_fields(fields))
    print(json.dumps(doc, ensure_ascii=False, indent=indent))
    sys.exit(0 if ok else 1)


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        emit(False, "invalid_arg", f"{self.prog}: {message}")


def guard(main, codes=None, cleanup=None):
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        if cleanup:
            cleanup()
        traceback.print_exc(file=sys.stderr)
        code = next((c for cls, c in (codes or {}).items() if isinstance(e, cls)), "internal")
        emit(False, code, f"{type(e).__name__}: {e}", detail=str(e))
