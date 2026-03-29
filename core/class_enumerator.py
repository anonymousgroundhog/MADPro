"""
Enumerates classes from APK files using androguard (no Docker needed).
Falls back to zipfile+DEX header parsing if androguard is unavailable.
"""
import zipfile
import struct


def list_classes_from_apk(apk_path: str) -> list[str]:
    """
    Returns a sorted list of class names from an APK.
    Format: 'com.example.ClassName'
    """
    try:
        return _list_via_androguard(apk_path)
    except ImportError:
        return _list_via_dex_header(apk_path)
    except Exception:
        return _list_via_dex_header(apk_path)


def _list_via_androguard(apk_path: str) -> list[str]:
    from androguard.core.apk import APK
    from androguard.core.dex import DEX

    apk = APK(apk_path)
    classes: set[str] = set()

    for dex_name in apk.get_dex_names():
        try:
            dex_data = apk.get_file(dex_name)
            d = DEX(dex_data)
            for cls in d.get_classes():
                name = cls.get_name()
                # Convert Ljava/lang/String; -> java.lang.String
                if name.startswith("L") and name.endswith(";"):
                    name = name[1:-1].replace("/", ".")
                classes.add(name)
        except Exception:
            continue

    return sorted(classes)


def _list_via_dex_header(apk_path: str) -> list[str]:
    """
    Minimal DEX parser that extracts class descriptors from the string pool.
    Handles classes.dex, classes2.dex, etc.
    """
    classes: set[str] = set()

    try:
        with zipfile.ZipFile(apk_path, "r") as zf:
            dex_names = [n for n in zf.namelist()
                         if n.startswith("classes") and n.endswith(".dex")]
            for dex_name in dex_names:
                try:
                    dex_data = zf.read(dex_name)
                    for cls in _parse_dex_classes(dex_data):
                        classes.add(cls)
                except Exception:
                    continue
    except Exception:
        pass

    return sorted(classes)


def _parse_dex_classes(dex_data: bytes) -> list[str]:
    """Parse class descriptors from DEX binary data."""
    classes = []
    try:
        if len(dex_data) < 112:
            return classes

        # DEX header offsets
        string_ids_size = struct.unpack_from("<I", dex_data, 56)[0]
        string_ids_off = struct.unpack_from("<I", dex_data, 60)[0]
        type_ids_size = struct.unpack_from("<I", dex_data, 64)[0]
        type_ids_off = struct.unpack_from("<I", dex_data, 68)[0]
        class_defs_size = struct.unpack_from("<I", dex_data, 96)[0]
        class_defs_off = struct.unpack_from("<I", dex_data, 100)[0]

        # Build string table
        strings = []
        for i in range(string_ids_size):
            str_off = struct.unpack_from("<I", dex_data, string_ids_off + i * 4)[0]
            # Read ULEB128 length
            length = 0
            shift = 0
            pos = str_off
            while pos < len(dex_data):
                b = dex_data[pos]
                pos += 1
                length |= (b & 0x7F) << shift
                shift += 7
                if not (b & 0x80):
                    break
            try:
                s = dex_data[pos:pos + length].decode("utf-8", errors="replace")
            except Exception:
                s = ""
            strings.append(s)

        # Build type table
        types = []
        for i in range(type_ids_size):
            idx = struct.unpack_from("<I", dex_data, type_ids_off + i * 4)[0]
            types.append(strings[idx] if idx < len(strings) else "")

        # Extract class descriptors
        for i in range(class_defs_size):
            off = class_defs_off + i * 32
            if off + 4 > len(dex_data):
                break
            type_idx = struct.unpack_from("<I", dex_data, off)[0]
            if type_idx < len(types):
                descriptor = types[type_idx]
                if descriptor.startswith("L") and descriptor.endswith(";"):
                    class_name = descriptor[1:-1].replace("/", ".")
                    classes.append(class_name)

    except Exception:
        pass

    return classes
