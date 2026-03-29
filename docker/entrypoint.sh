#!/bin/bash
set -e

# entrypoint.sh — routes commands to the correct tool
# Usage:
#   inject <apk_dir_or_file> <output_dir> [class_filter_csv]
#   get-main-activity <apk_file>

ANDROID_PLATFORMS="/app/android/platforms"
JAR_CP="/app:/app/jar_libs/*"
APKTOOL="java -jar /usr/local/lib/apktool.jar"

case "$1" in
    inject)
        APK_INPUT="$2"
        OUTPUT_DIR="$3"
        CLASS_FILTER="${4:-}"

        if [ -z "$APK_INPUT" ] || [ -z "$OUTPUT_DIR" ]; then
            echo "Usage: inject <apk_dir_or_file> <output_dir> [class_filter_csv]" >&2
            exit 1
        fi

        mkdir -p "$OUTPUT_DIR"

        CMD=(java -Xmx8g -cp "$JAR_CP" LogInjector "$ANDROID_PLATFORMS" "$APK_INPUT" "$OUTPUT_DIR")
        if [ -n "$CLASS_FILTER" ]; then
            CMD+=("$CLASS_FILTER")
        fi

        exec "${CMD[@]}"
        ;;

    get-main-activity)
        APK_FILE="$2"
        if [ -z "$APK_FILE" ]; then
            echo "Usage: get-main-activity <apk_file>" >&2
            exit 1
        fi

        TMPDIR=$(mktemp -d)
        trap "rm -rf $TMPDIR" EXIT

        # Decode only the manifest — redirect ALL apktool output to stderr so
        # stdout stays clean for just the activity name result.
        $APKTOOL decode --no-res --no-src --force -o "$TMPDIR/decoded" "$APK_FILE" >&2 2>&1 || \
        $APKTOOL d --no-res --no-src --force -o "$TMPDIR/decoded" "$APK_FILE" >&2 2>&1 || true

        MANIFEST="$TMPDIR/decoded/AndroidManifest.xml"
        if [ ! -f "$MANIFEST" ]; then
            echo "ERROR: Could not decode AndroidManifest.xml" >&2
            exit 1
        fi

        # Parse manifest — only class names printed to stdout; all errors to stderr
        python3 - "$MANIFEST" <<'PYEOF'
import sys
import xml.etree.ElementTree as ET

manifest_path = sys.argv[1]
try:
    tree = ET.parse(manifest_path)
    root = tree.getroot()

    main_activities = []
    for activity in root.iter('activity'):
        name = activity.get('{http://schemas.android.com/apk/res/android}name', '')
        for intent_filter in activity.findall('intent-filter'):
            actions = [a.get('{http://schemas.android.com/apk/res/android}name', '')
                       for a in intent_filter.findall('action')]
            categories = [c.get('{http://schemas.android.com/apk/res/android}name', '')
                          for c in intent_filter.findall('category')]
            if 'android.intent.action.MAIN' in actions and \
               'android.intent.category.LAUNCHER' in categories:
                main_activities.append(name)

    if main_activities:
        for a in main_activities:
            print(a)
    else:
        # Fallback: any activity name containing 'main' or 'launch'
        for activity in root.iter('activity'):
            name = activity.get('{http://schemas.android.com/apk/res/android}name', '')
            if 'main' in name.lower() or 'launch' in name.lower():
                print(name)
except Exception as e:
    print(f"ERROR: {e}", file=sys.stderr)
    sys.exit(1)
PYEOF
        ;;

    *)
        echo "Unknown command: $1" >&2
        echo "Available commands: inject, get-main-activity" >&2
        exit 1
        ;;
esac
