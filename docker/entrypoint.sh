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

        # aapt dump badging prints a line like:
        #   launchable-activity: name='com.example.MainActivity'  label='' icon='...'
        # Extract just the class name from that line.
        aapt dump badging "$APK_FILE" 2>/dev/null \
            | grep '^launchable-activity:' \
            | sed "s/.*name='//;s/'.*//"
        ;;

    *)
        echo "Unknown command: $1" >&2
        echo "Available commands: inject, get-main-activity" >&2
        exit 1
        ;;
esac
