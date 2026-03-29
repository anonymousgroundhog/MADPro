#!/usr/bin/env python3
# Run with: python3 main.py
"""
MADPro — Mobile APK Decompiler & Injector
Entry point.
"""
import sys
import os

# Ensure project root is on the path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from gui.app import main

if __name__ == "__main__":
    main()
