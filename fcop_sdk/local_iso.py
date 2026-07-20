# -*- coding: utf-8 -*-
"""Local wall-clock ISO helpers (offset, not bare Z)."""
from __future__ import annotations

from datetime import datetime, timezone


def to_local_iso_string(d: datetime | None = None, *, include_ms: bool = False) -> str:
    dt = d or datetime.now().astimezone()
    if dt.tzinfo is None:
        dt = dt.astimezone()
    off = dt.utcoffset()
    if off is None:
        off_sec = 0
    else:
        off_sec = int(off.total_seconds())
    sign = "+" if off_sec >= 0 else "-"
    abs_sec = abs(off_sec)
    oh = abs_sec // 3600
    om = (abs_sec % 3600) // 60
    base = dt.strftime("%Y-%m-%dT%H:%M:%S")
    if include_ms:
        base = f"{base}.{dt.microsecond // 1000:03d}"
    return f"{base}{sign}{oh:02d}:{om:02d}"


def to_utc_iso_string(d: datetime | None = None) -> str:
    dt = d or datetime.now(timezone.utc)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    else:
        dt = dt.astimezone(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S") + "Z"


_OFFSET_MINUTES_TO_IANA: dict[int, str] = {
    480: "Asia/Shanghai",
    540: "Asia/Tokyo",
    420: "Asia/Bangkok",
    330: "Asia/Kolkata",
    0: "UTC",
    -300: "America/New_York",
    -480: "America/Los_Angeles",
}


def get_local_timezone() -> str:
    try:
        dt = datetime.now().astimezone()
        tzinfo = dt.tzinfo
        if tzinfo is not None and hasattr(tzinfo, "key"):
            return str(tzinfo.key)
        off = dt.utcoffset()
        if off is not None:
            total_min = int(off.total_seconds()) // 60
            mapped = _OFFSET_MINUTES_TO_IANA.get(total_min)
            if mapped:
                return mapped
        tz = dt.tzname()
        if tz:
            return tz
    except Exception:
        pass
    try:
        import time as _time

        tzname = _time.tzname[0] if _time.daylight == 0 else _time.tzname[1]
        if tzname:
            return tzname
    except Exception:
        pass
    return "UTC"
