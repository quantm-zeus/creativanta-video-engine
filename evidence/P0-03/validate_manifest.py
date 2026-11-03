#!/usr/bin/env python3
"""
Manifest Validation Script for Task P0-03.
Validates the Rights and Provenance Manifest (rights-manifest.json)
and asserts compliance with CVE architecture, security boundaries,
Vietnamese typography requirements, and anti-contamination policies.
"""

from pathlib import Path
import hashlib
import json
import re
import sys

def main():
    root = Path(__file__).resolve().parent.parent.parent
    manifest_path = root / "evidence/P0-03/rights-manifest.json"
    fixtures_dir = root / "evidence/P0-03/fixtures"

    errors = []
    checks_passed = 0

    if not manifest_path.is_file():
        print(f"FAIL: Missing manifest file at {manifest_path}", file=sys.stderr)
        sys.exit(1)

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        checks_passed += 1
    except Exception as e:
        print(f"FAIL: Invalid JSON in {manifest_path}: {e}", file=sys.stderr)
        sys.exit(1)

    # 1. Root structure and metadata
    required_root_keys = [
        "manifest_version", "task_id", "stream", "fixtures",
        "assets", "anti_contamination_audit", "vietnamese_typography_compliance"
    ]
    for key in required_root_keys:
        if key not in manifest:
            errors.append(f"Missing root key: {key}")
        else:
            checks_passed += 1

    if manifest.get("task_id") != "P0-03":
        errors.append(f"Unexpected task_id: {manifest.get('task_id')}")
    if manifest.get("stream") != "D":
        errors.append(f"Unexpected stream: {manifest.get('stream')}")

    # 2. Fixtures Verification
    fixtures = manifest.get("fixtures", {})
    expected_fixtures = {"POC-01", "POC-02", "POC-03"}
    if set(fixtures.keys()) != expected_fixtures:
        errors.append(f"Fixtures mismatch: expected {expected_fixtures}, found {set(fixtures.keys())}")

    # Check POC-01 spec
    poc01 = fixtures.get("POC-01", {})
    if poc01.get("canvas", {}).get("width") != 720 or poc01.get("canvas", {}).get("height") != 1280:
        errors.append("POC-01 canvas must be 720x1280 (9:16 vertical)")
    if poc01.get("duration_frames") != 450 or poc01.get("duration_seconds") != 15.0:
        errors.append("POC-01 duration must be 450 frames (15.0s)")
    if poc01.get("scenes_count") != 3:
        errors.append("POC-01 scenes_count must be 3")

    # Check POC-02 spec
    poc02 = fixtures.get("POC-02", {})
    if poc02.get("canvas", {}).get("width") != 1280 or poc02.get("canvas", {}).get("height") != 720:
        errors.append("POC-02 canvas must be 1280x720 (16:9 landscape)")
    if poc02.get("duration_frames") != 900 or poc02.get("duration_seconds") != 30.0:
        errors.append("POC-02 duration must be 900 frames (30.0s)")
    if poc02.get("scenes_count") != 4:
        errors.append("POC-02 scenes_count must be 4")
    if poc02.get("subtitles_locale") != "vi-VN":
        errors.append("POC-02 subtitles_locale must be vi-VN")

    # Check POC-03 spec
    poc03 = fixtures.get("POC-03", {})
    if poc03.get("canvas", {}).get("width") != 720 or poc03.get("canvas", {}).get("height") != 1280:
        errors.append("POC-03 canvas must be 720x1280 (9:16 vertical)")
    if poc03.get("duration_frames") != 1350 or poc03.get("duration_seconds") != 45.0:
        errors.append("POC-03 duration must be 1350 frames (45.0s)")
    if poc03.get("scenes_count") != 3:
        errors.append("POC-03 scenes_count must be 3")
    if poc03.get("target_loudness_lufs") != -16.0:
        errors.append("POC-03 target_loudness_lufs must be -16.0 LUFS")
    if poc03.get("max_true_peak_dbtp") != -1.0:
        errors.append("POC-03 max_true_peak_dbtp must be -1.0 dBTP")

    # 3. Assets Verification
    assets = manifest.get("assets", [])
    if not isinstance(assets, list) or len(assets) < 12:
        errors.append(f"Insufficient assets declared in manifest: found {len(assets)}")

    assets_by_id = {}
    assets_by_asset_id = {}
    hex_pattern = re.compile(r"^[0-9a-f]{64}$")

    for a in assets:
        a_id = a.get("id")
        ast_id = a.get("asset_id")
        if not a_id or not ast_id:
            errors.append(f"Asset missing id or asset_id: {a}")
            continue

        if a_id in assets_by_id:
            errors.append(f"Duplicate asset id: {a_id}")
        assets_by_id[a_id] = a

        if ast_id in assets_by_asset_id:
            errors.append(f"Duplicate asset_id: {ast_id}")
        assets_by_asset_id[ast_id] = a

        # Check sha256 format
        sha = a.get("sha256", "")
        if not hex_pattern.match(sha):
            errors.append(f"Asset {a_id} invalid sha256 format: {sha}")

        # Check bytes
        b = a.get("bytes", 0)
        if not isinstance(b, int) or b <= 0:
            errors.append(f"Asset {a_id} invalid bytes count: {b}")

        # Check rights
        r = a.get("rights", {})
        basis = r.get("basis")
        if basis not in {"owned", "licensed", "public_domain"}:
            errors.append(f"Asset {a_id} invalid rights basis: {basis}")
        if not r.get("license"):
            errors.append(f"Asset {a_id} missing license")
        if not r.get("attribution"):
            errors.append(f"Asset {a_id} missing attribution")
        if r.get("commercial_use_allowed") is not True:
            errors.append(f"Asset {a_id} commercial_use_allowed must be true")

        # Check category specific constraints
        cat = a.get("category")
        if cat == "font":
            cov = a.get("vietnamese_coverage", {})
            if cov.get("status") != "verified_complete":
                errors.append(f"Font {a_id} vietnamese_coverage status not verified_complete")
        elif cat == "video":
            if a.get("audio_track_included") is not False:
                errors.append(f"Video {a_id} must have audio_track_included=false to prevent implicit audio bleed")
            if a.get("cfr") is not True:
                errors.append(f"Video {a_id} must be CFR (Constant Frame Rate)")
        elif cat == "audio":
            if a.get("sample_rate") != 48000:
                errors.append(f"Audio {a_id} sample_rate must be 48000 Hz")
            if a.get("channels") != 2:
                errors.append(f"Audio {a_id} channels must be 2 (stereo)")

        checks_passed += 1

    # Check fixture asset_id references exist
    for f_id, f_data in fixtures.items():
        for ast_ref in f_data.get("asset_ids", []):
            if ast_ref not in assets_by_asset_id:
                errors.append(f"Fixture {f_id} references nonexistent asset_id: {ast_ref}")
            else:
                checks_passed += 1

    # 4. On-disk SVG Fixtures Verification
    if fixtures_dir.is_dir():
        for svg_file in fixtures_dir.glob("*.svg"):
            content = svg_file.read_text(encoding="utf-8")
            # Security scan: no script or foreignObject
            if re.search(r"<script\b|<foreignObject\b|javascript:|onerror=", content, re.I):
                errors.append(f"Security violation: active script pattern found in {svg_file.name}")

            # Check sha256 and size against manifest
            actual_sha = hashlib.sha256(svg_file.read_bytes()).hexdigest()
            actual_size = svg_file.stat().st_size

            matched = False
            for a in assets:
                if a.get("filename") == svg_file.name:
                    matched = True
                    if a.get("sha256") != actual_sha:
                        errors.append(f"SHA-256 mismatch for {svg_file.name}: manifest has {a.get('sha256')}, file has {actual_sha}")
                    if a.get("bytes") != actual_size:
                        errors.append(f"Byte size mismatch for {svg_file.name}: manifest has {a.get('bytes')}, file has {actual_size}")
                    break
            if not matched:
                errors.append(f"SVG fixture on disk not declared in manifest: {svg_file.name}")
            checks_passed += 1

    # 5. Anti-contamination Verification
    audit = manifest.get("anti_contamination_audit", {})
    if audit.get("audit_status") != "VERIFIED_COMPLIANT":
        errors.append("anti_contamination_audit audit_status must be VERIFIED_COMPLIANT")
    rules = audit.get("rules_enforced", [])
    if len(rules) < 4:
        errors.append("At least 4 anti-contamination rules must be explicitly audited")

    # Negative pattern scan: ensure no HeyGen, unpinned CDN, or unlicensed demo URLs
    raw_manifest = manifest_path.read_text(encoding="utf-8")
    for blocked_pattern in ["fonts.googleapis.com", "api.heygen.com", "remotion-dev/template", "big_buck_bunny"]:
        if blocked_pattern in raw_manifest:
            errors.append(f"Contamination error: manifest references forbidden upstream pattern '{blocked_pattern}'")

    # 6. Vietnamese Typography Compliance
    vn = manifest.get("vietnamese_typography_compliance", {})
    if "vi-VN" not in vn.get("target_locales", []):
        errors.append("vi-VN must be in target_locales")
    if "₫" not in vn.get("currency_symbol", ""):
        errors.append("Vietnamese currency symbol ₫ must be present")
    if vn.get("safe_margin_px") != 48:
        errors.append("safe_margin_px must be 48")

    result = {
        "status": "PASS" if not errors else "FAIL",
        "manifest_path": str(manifest_path.relative_to(root)),
        "fixtures_checked": len(fixtures),
        "assets_checked": len(assets),
        "svg_fixtures_verified_on_disk": len(list(fixtures_dir.glob("*.svg"))),
        "checks_passed": checks_passed,
        "errors_count": len(errors),
        "errors": errors
    }

    print(json.dumps(result, indent=2, ensure_ascii=False))
    sys.exit(0 if not errors else 1)

if __name__ == "__main__":
    main()
