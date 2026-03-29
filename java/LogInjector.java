import soot.*;
import soot.jimple.*;
import soot.options.Options;
import soot.util.Chain;

import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;

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

        if (args.length < 3 || args.length > 4) {
            System.err.println("Usage: java LogInjector <android-platforms> <apk-dir-or-file> <output-dir> [class-filter-csv]");
            System.exit(1);
        }

        String androidPlatforms = args[0];
        String apkInput         = args[1];   // may be a dir (split APKs) or a single .apk
        String outputDir        = args[2];
        String classFilterCsv   = args.length == 4 ? args[3] : "";

        final Set<String> classFilter = new HashSet<>();
        if (!classFilterCsv.isEmpty()) {
            for (String c : classFilterCsv.split(",")) {
                String t = c.trim();
                if (!t.isEmpty()) classFilter.add(t.toLowerCase());
            }
        }

        System.out.println("APK input : " + apkInput);
        System.out.println("Output    : " + outputDir);
        System.out.println("Filter    : " + (classFilter.isEmpty() ? "(all classes)" : classFilter));

        setupSoot(androidPlatforms, apkInput, outputDir);

        PackManager.v().getPack("jtp").add(
            new Transform("jtp.LogInjectorTransform", new BodyTransformer() {
                @Override
                protected void internalTransform(Body body, String phaseName, Map<String, String> opts) {
                    SootMethod method = body.getMethod();

                    // Class filter
                    if (!classFilter.isEmpty()) {
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
        setupSoot(androidPlatforms, apkPath, "/tmp/soot-list-classes-output");
        Scene.v().loadNecessaryClasses();
        for (SootClass sc : Scene.v().getApplicationClasses()) {
            System.out.println(sc.getName());
        }
    }

    private static void setupSoot(String androidPlatforms, String apkInput, String outputDir) {
        G.reset();

        Options.v().set_allow_phantom_refs(true);
        Options.v().set_prepend_classpath(true);
        Options.v().set_validate(false);
        Options.v().set_process_multiple_dex(true);
        Options.v().set_src_prec(Options.src_prec_apk);
        Options.v().set_output_format(Options.output_format_dex);
        Options.v().set_android_jars(androidPlatforms);
        Options.v().set_full_resolver(true);
        Options.v().set_no_bodies_for_excluded(true);
        Options.v().set_ignore_resolution_errors(true);
        // Single-threaded: avoids ConcurrentModificationException on Chain<Unit>
        Options.v().set_num_threads(1);

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

        Stmt logStmt = Jimple.v().newInvokeStmt(
            Jimple.v().newStaticInvokeExpr(
                logMethod.makeRef(),
                StringConstant.v(LOG_TAG),
                StringConstant.v("Entering method: " + sig)
            )
        );

        // Insert after all IdentityStmts (parameter/this assignments)
        Unit insertionPoint = null;
        for (Unit u : units) {
            if (!(u instanceof IdentityStmt)) {
                insertionPoint = u;
                break;
            }
        }

        if (insertionPoint == null) {
            units.addFirst(logStmt);
        } else {
            units.insertBefore(logStmt, insertionPoint);
        }
    }
}
