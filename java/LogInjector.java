import soot.*;
import soot.jimple.*;
import soot.options.Options;
import soot.util.Chain;

import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.Arrays;

/**
 * Soot transformer that injects Log.d("SootInjection", "Entering method: <sig>")
 * at the start of every non-abstract, non-native method.
 *
 * Obfuscation-tolerant: per-method exceptions are caught and skipped so a single
 * bad method body cannot stall or abort the whole APK.
 *
 * Usage:
 *   inject mode:      java LogInjector <android-platforms> <apk-dir-or-file> <output-dir> [class-filter-csv]
 *   list-class mode:  java LogInjector --list-classes <android-platforms> <apk-file>
 */
public class LogInjector {

    private static final String LOG_TAG = "SootInjection";

    private static final AtomicInteger injected = new AtomicInteger(0);
    private static final AtomicInteger skipped  = new AtomicInteger(0);

    public static void main(String[] args) {
        if (args.length >= 1 && args[0].equals("--list-classes")) {
            if (args.length != 3) {
                System.err.println("Usage: java LogInjector --list-classes <android-platforms> <apk-file>");
                System.exit(1);
            }
            listClasses(args[1], args[2]);
            return;
        }

        final boolean injectAll = args.length > 0 && args[0].equals("--inject-all");
        int argIdx = injectAll ? 1 : 0;

        String[] remainingArgs = new String[args.length - argIdx];
        System.arraycopy(args, argIdx, remainingArgs, 0, remainingArgs.length);

        if (remainingArgs.length < 3 || remainingArgs.length > 4) {
            System.err.println("Usage: java LogInjector [--inject-all] <android-platforms> <apk-dir-or-file> <output-dir> [class-filter-csv]");
            System.exit(1);
        }

        String androidPlatforms = remainingArgs[0];
        String apkInput         = remainingArgs[1];   // may be a dir (split APKs) or a single .apk
        String outputDir        = remainingArgs[2];
        String classFilterCsv   = remainingArgs.length == 4 ? remainingArgs[3] : "";

        final Set<String> classFilter = new HashSet<>();
        if (!classFilterCsv.isEmpty()) {
            for (String c : classFilterCsv.split(",")) {
                String t = c.trim();
                if (!t.isEmpty()) classFilter.add(t.toLowerCase());
            }
        }

        System.out.println("APK input     : " + apkInput);
        System.out.println("Output        : " + outputDir);
        System.out.println("Inject all    : " + (injectAll ? "YES (include framework + ignore patterns)" : "NO (app classes only)"));
        System.out.println("Class filter  : " + (injectAll ? "(disabled by --inject-all)" : (classFilter.isEmpty() ? "(none)" : classFilter)));

        setupSoot(androidPlatforms, apkInput, outputDir, injectAll);

        PackManager.v().getPack("jtp").add(
            new Transform("jtp.LogInjectorTransform", new BodyTransformer() {
                @Override
                protected void internalTransform(Body body, String phaseName, Map<String, String> opts) {
                    SootMethod method = body.getMethod();

                    // Class filter — skip if --inject-all flag set
                    if (!injectAll && !classFilter.isEmpty()) {
                        String className = method.getDeclaringClass().getName().toLowerCase();
                        boolean matches = false;
                        for (String f : classFilter) {
                            if (className.contains(f)) { matches = true; break; }
                        }
                        if (!matches) return;
                    }

                    if (method.isAbstract() || method.isNative()) return;

                    // Wrap each method in try/catch — obfuscated bodies can throw
                    // various runtime exceptions during Jimple manipulation.
                    try {
                        injectLog(body);
                        injected.incrementAndGet();
                    } catch (Exception e) {
                        skipped.incrementAndGet();
                        System.err.println("[SKIP] " + method.getSignature() + " — " + e.getClass().getSimpleName() + ": " + e.getMessage());
                    }
                }
            })
        );

        soot.Main.main(new String[]{"-process-dir", apkInput, "-force-overwrite"});

        System.out.println("Injection complete. Injected: " + injected.get()
                + "  Skipped: " + skipped.get()
                + "  Output: " + outputDir);
    }

    private static void listClasses(String androidPlatforms, String apkPath) {
        setupSoot(androidPlatforms, apkPath, "/tmp/soot-list-classes-output", false);
        Scene.v().loadNecessaryClasses();
        for (SootClass sc : Scene.v().getApplicationClasses()) {
            System.out.println(sc.getName());
        }
    }

    private static void setupSoot(String androidPlatforms, String apkInput, String outputDir, boolean injectAll) {
        G.reset();

        Options.v().set_allow_phantom_refs(true);
        Options.v().set_prepend_classpath(true);
        Options.v().set_validate(false);
        Options.v().set_process_multiple_dex(true);
        Options.v().set_src_prec(Options.src_prec_apk);
        Options.v().set_output_format(Options.output_format_dex);
        Options.v().set_android_jars(androidPlatforms);
        // Don't force-resolve every reachable class — massively reduces heap use
        Options.v().set_full_resolver(false);
        Options.v().set_no_bodies_for_excluded(true);
        Options.v().set_ignore_resolution_errors(true);
        // Single-threaded: avoids ConcurrentModificationException on Chain<Unit>
        Options.v().set_num_threads(1);

        // Exclude Android/Java framework and common library packages from body loading.
        // Soot still resolves their signatures (phantom refs) but won't JImplify them,
        // which is the main source of heap exhaustion on large APKs.
        // Skip exclusions if --inject-all flag set.
        if (!injectAll) {
            List<String> excludes = new ArrayList<>(Arrays.asList(
                "java.", "javax.", "sun.", "android.", "androidx.",
                "com.google.android.", "com.android.",
                "kotlin.", "kotlinx.",
                "org.apache.", "org.xml.", "org.json.", "org.w3c.",
                "junit.", "dalvik."
            ));
            Options.v().set_exclude(excludes);
        }

        List<String> processDirs = new ArrayList<>();
        processDirs.add(apkInput);
        Options.v().set_process_dir(processDirs);
        Options.v().set_output_dir(outputDir);

        Scene.v().loadNecessaryClasses();
    }

    private static void injectLog(Body body) {
        JimpleBody jimpleBody = (JimpleBody) body;
        Chain<Unit> units = jimpleBody.getUnits();
        String sig = body.getMethod().getSignature();

        SootClass logClass   = Scene.v().getSootClass("android.util.Log");
        SootMethod logMethod = logClass.getMethod("int d(java.lang.String,java.lang.String)");

        // Find insertion point: after IdentityStmts + first specialinvoke (for constructors)
        Unit insertionPoint = null;
        boolean foundSpecialInvoke = false;
        for (Unit u : units) {
            if (u instanceof IdentityStmt) continue;
            // In constructors, skip past the super() call (specialinvoke)
            if (!foundSpecialInvoke && u instanceof InvokeStmt) {
                InvokeStmt invoke = (InvokeStmt) u;
                if (invoke.getInvokeExpr() instanceof SpecialInvokeExpr) {
                    foundSpecialInvoke = true;
                    continue;
                }
            }
            insertionPoint = u;
            break;
        }
        if (insertionPoint == null) {
            // If no insertion point found, insert before return
            for (Unit u : units) {
                if (u instanceof ReturnVoidStmt) {
                    insertionPoint = u;
                    break;
                }
            }
        }

        // Log method signature only (no parameters)
        Stmt logStmt = Jimple.v().newInvokeStmt(
            Jimple.v().newStaticInvokeExpr(
                logMethod.makeRef(),
                StringConstant.v(LOG_TAG),
                StringConstant.v("Entering: " + sig)
            )
        );

        if (insertionPoint == null) {
            units.addFirst(logStmt);
        } else {
            units.insertBefore(logStmt, insertionPoint);
        }
    }
}
