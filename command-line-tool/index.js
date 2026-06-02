#!/usr/bin/env node
/**
 * MADPro CLI — command-line interface for APK download, injection, and instrumentation.
 * Mirrors the Tools tab of the apk-dashboard web UI.
 *
 * Usage: node index.js <command> [options]
 *   or:  madpro <command> [options]   (after npm install -g or npm link)
 *
 * Commands:
 *   help-menu          Detailed help for all commands
 *   check              Check tool availability
 *   devices            List connected ADB devices and AVDs
 *   start-emulator     Launch an AVD and wait until booted
 *   setup-emulator     Download image, create/recreate AVD, and boot it
 *   check-emulator     Diagnose emulator GPU, KVM, GuestAngle, and AVD readiness
 *   download           Download APKs (ApkPure / Google Play / Androzoo)
 *   reset-failed       Delete .skip_list.json files to retry failed apps
 *   compile            Compile LogInjector.java
 *   inject             Inject logging into APKs via Soot
 *   instrument         Install, run, capture logcat, uninstall
 *   uninstall          Bulk uninstall by category
 *   uninstall-playstore  Uninstall all Play Store apps on device
 *   kanban             Scan APK directory and show ads/no-ads Kanban board
 */

const { Command } = require("commander");
const program = new Command();

program
  .name("madpro")
  .description("MADPro APK analysis CLI")
  .version("1.0.0");

require("./commands/help-menu").register(program);
require("./commands/check").register(program);
require("./commands/devices").register(program);
require("./commands/start-emulator").register(program);
require("./commands/setup-emulator").register(program);
require("./commands/check-emulator").register(program);
require("./commands/download").register(program);
require("./commands/reset-failed").register(program);
require("./commands/compile").register(program);
require("./commands/inject").register(program);
require("./commands/instrument").register(program);
require("./commands/uninstall").register(program);
require("./commands/kanban").register(program);

program.parse(process.argv);
