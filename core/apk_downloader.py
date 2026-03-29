"""
APK download orchestration using apkeep.

apkeep is a CLI tool that can download APKs from:
  - ApkPure (no auth required)  — backend id: "apkpure"
  - Google Play (token required) — backend id: "google-play"

Install apkeep:
  cargo install apkeep
  OR download binary from https://github.com/EFForg/apkeep/releases
"""
import os
import subprocess
import threading
from dataclasses import dataclass, field
from typing import Callable


@dataclass
class DownloadJob:
    category_id: str        # e.g. "SOCIAL"
    category_name: str      # e.g. "Social"
    packages: list[str]     # package names to download
    output_dir: str
    backend: str            # "apkpure" or "google-play"
    gplay_email: str = ""
    gplay_token: str = ""


def is_apkeep_available() -> bool:
    try:
        subprocess.run(["apkeep", "--version"], capture_output=True, timeout=5)
        return True
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def get_top_packages(
    category_id: str,
    count: int,
    backend: str = "apkpure",
    on_log: Callable[[str], None] | None = None,
) -> list[str]:
    """
    Returns up to `count` package names for the top free apps in `category_id`.

    apkeep doesn't have a native chart-listing mode, so we use a curated
    seed list per category as the source of package names. For production use,
    this can be replaced with a gplaycli or Play Store chart scrape.
    """
    seed = _CATEGORY_SEEDS.get(category_id, [])
    result = seed[:count]
    if on_log:
        on_log(f"  [{category_id}] Using {len(result)} package(s) from seed list.")
    return result


def download_apk(
    package: str,
    output_dir: str,
    backend: str,
    email: str = "",
    token: str = "",
    on_log: Callable[[str], None] | None = None,
    stop_event: threading.Event | None = None,
) -> bool:
    """
    Downloads a single APK using apkeep.
    Output is written to output_dir/<package>/<package>.apk
    Returns True on success.
    """
    os.makedirs(output_dir, exist_ok=True)

    cmd = ["apkeep", "-a", package, "-d", output_dir]

    if backend == "google-play":
        if not email or not token:
            if on_log:
                on_log(f"  [SKIP] {package} — Google Play requires email + AAS token.")
            return False
        cmd += ["--from", "google-play", "-u", email, "-t", token]
    else:
        cmd += ["--from", "apk-pure"]

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        for line in iter(proc.stdout.readline, ""):
            if stop_event and stop_event.is_set():
                proc.terminate()
                return False
            if on_log:
                on_log(f"  {line.rstrip()}")
        proc.wait()
        return proc.returncode == 0

    except FileNotFoundError:
        if on_log:
            on_log("ERROR: apkeep not found. Install with: cargo install apkeep")
        return False
    except Exception as e:
        if on_log:
            on_log(f"ERROR: {e}")
        return False


def run_download_jobs(
    jobs: list[DownloadJob],
    on_log: Callable[[str], None],
    on_progress: Callable[[int, int], None],
    stop_event: threading.Event,
) -> dict[str, str]:
    """
    Runs all download jobs sequentially.
    Returns {package: 'ok'|'failed'|'cancelled'|'skipped'}.
    """
    # Count total packages
    total = sum(len(j.packages) for j in jobs)
    results: dict[str, str] = {}
    current = 0

    for job in jobs:
        if stop_event.is_set():
            for pkg in job.packages:
                results[pkg] = "cancelled"
            continue

        on_log(f"--- Category: {job.category_name} ({len(job.packages)} app(s)) ---")
        cat_output = os.path.join(job.output_dir, job.category_id)

        for package in job.packages:
            if stop_event.is_set():
                results[package] = "cancelled"
                current += 1
                on_progress(current, total)
                continue

            on_log(f"  Downloading: {package}")
            on_progress(current, total)

            success = download_apk(
                package=package,
                output_dir=os.path.join(cat_output, package),
                backend=job.backend,
                email=job.gplay_email,
                token=job.gplay_token,
                on_log=on_log,
                stop_event=stop_event,
            )

            current += 1
            if stop_event.is_set():
                results[package] = "cancelled"
            elif success:
                results[package] = "ok"
                on_log(f"  [OK] {package}")
            else:
                results[package] = "failed"
                on_log(f"  [FAILED] {package}")

        on_progress(current, total)

    return results


# ---------------------------------------------------------------------------
# Curated seed lists — top free apps per category (package names)
# Replace or extend with a live chart API for production use.
# ---------------------------------------------------------------------------

_CATEGORY_SEEDS: dict[str, list[str]] = {
    "GAME_ACTION": [
        "com.kiloo.subwaysurf", "com.supercell.clashofclans",
        "com.activision.callofduty.shooter", "com.gameloft.android.ANMP.GloftA9HM",
        "com.mobile.legends", "com.tencent.ig", "com.dts.freefireth",
        "com.mojang.minecraftpe", "com.ea.game.nfs14_row", "com.miniclip.agar.io",
    ],
    "GAME_CASUAL": [
        "com.king.candycrushsaga", "com.outfit7.mytalkingtom2",
        "com.imangi.templerun2", "com.halfbrick.fruitninjafree",
        "com.rovio.angrybirds2", "com.playgendary.bubblewitch3",
        "com.bigduckgames.flow", "com.netflix.NGP.AndroidTV",
        "com.dena.a12026418", "jp.gungho.pad",
    ],
    "GAME_PUZZLE": [
        "com.king.candycrushsodaga", "com.gram.chess",
        "com.ea.game.sudoku", "com.halfbrick.jetpackjoyride",
        "com.netflix.NGP.AndroidTV", "com.innersloth.spacemafia",
        "com.scopely.monopoly", "com.nianticlabs.pokemongo",
        "com.gameloft.android.ANMP.GloftPOP", "com.disney.WhoWantsToBeAMillionaire_goo",
    ],
    "GAME_ROLE_PLAYING": [
        "com.supercell.clashroyale", "com.ngame.slimesaga",
        "com.garena.lifeafter", "jp.gungho.pad",
        "com.netease.onmyoji", "com.activision.callofduty.warzone",
        "com.mi.MIUI", "air.com.lunagames.pathfinder",
        "com.squareenix.ffbe", "com.nexon.bingo",
    ],
    "SOCIAL": [
        "com.instagram.android", "com.facebook.katana",
        "com.twitter.android", "com.snapchat.android",
        "com.pinterest", "com.reddit.frontpage",
        "com.linkedin.android", "com.discord",
        "com.tumblr", "tv.twitch.android.app",
    ],
    "COMMUNICATION": [
        "com.whatsapp", "org.telegram.messenger",
        "com.viber.voip", "com.skype.raider",
        "com.google.android.talk", "com.microsoft.teams",
        "com.slack", "com.zoom.videomeetings",
        "com.signal.android", "com.facebook.orca",
    ],
    "PRODUCTIVITY": [
        "com.microsoft.office.word", "com.microsoft.office.excel",
        "com.google.android.apps.docs", "com.google.android.apps.sheets",
        "com.dropbox.android", "com.evernote",
        "com.todoist.android", "com.anydo",
        "com.notion.id", "com.trello",
    ],
    "ENTERTAINMENT": [
        "com.netflix.mediaclient", "com.amazon.avod.thirdpartyclient",
        "com.disney.disneyplus", "com.hbo.hbonow",
        "com.hulu.plus", "com.google.android.youtube",
        "com.spotify.music", "com.tiktok",
        "tv.pluto.android", "com.peacocktv.peacockandroid",
    ],
    "FINANCE": [
        "com.paypal.android.p2pmobile", "com.venmo",
        "com.cashapp", "com.robinhood.android",
        "com.coinbase.android", "com.wealthfront.android",
        "com.bankofamerica.cashpromobile", "com.chase.sig.android",
        "com.mint.android", "com.acorns.android",
    ],
    "HEALTH_AND_FITNESS": [
        "com.myfitnesspal.android", "com.nike.plusrunning",
        "com.strava", "com.fitbit.FitbitMobile",
        "com.headspace.android", "com.calm.android",
        "com.peloton.android", "com.garmin.android.apps.connectmobile",
        "com.duolingo", "com.noom.android",
    ],
    "EDUCATION": [
        "com.duolingo", "com.kahoot.academy",
        "com.coursera.android", "com.udemy.android",
        "com.khanacademy.android", "com.brainly.pl",
        "com.quizlet.quizletandroid", "com.photomath",
        "com.socratic.android", "com.ted.android",
    ],
    "MUSIC_AND_AUDIO": [
        "com.spotify.music", "com.pandora.android",
        "deezer.android.app", "com.soundcloud.android",
        "com.shazam.android", "com.apple.android.music",
        "com.tidal.android", "tunein.player",
        "com.amazon.mp3", "com.last.fm",
    ],
    "NEWS_AND_MAGAZINES": [
        "com.google.android.apps.magazines", "flipboard.app",
        "com.nytimes.android", "com.bbc.mobile.news.ww",
        "com.cnn.mobile.android.phone", "com.reddit.frontpage",
        "com.feedly.android", "com.buzzfeed.android",
        "com.medium.reader", "com.apple.news",
    ],
    "SHOPPING": [
        "com.amazon.mShop.android.shopping", "com.ebay.mobile",
        "com.etsy.android", "com.wish.android",
        "com.target.ui", "com.walmart.android",
        "com.bestbuy.android", "com.shein.android",
        "com.poshmark.app", "com.mercari.android",
    ],
    "TRAVEL_AND_LOCAL": [
        "com.airbnb.android", "com.booking.android",
        "com.expedia.bookings", "com.hotels.android",
        "com.tripadvisor.tripadvisor", "com.google.android.apps.maps",
        "com.waze", "com.kayak.android",
        "com.ubercab", "com.lyft.android",
    ],
    "TOOLS": [
        "com.google.android.apps.translate", "com.adobe.scan.android",
        "com.microsoft.launcher", "com.lastpass.lpandroid",
        "com.bitwarden.mobile", "com.nordvpn.android",
        "com.expressvpn.vpn", "com.cleanmaster.mguard",
        "com.es.fileexplorer", "jackpal.androidterm",
    ],
    "PHOTOGRAPHY": [
        "com.instagram.android", "com.snapchat.android",
        "com.vsco.cam", "com.picsart.studio",
        "com.adobe.lrmobile", "com.lightricks.facetune2",
        "com.google.android.apps.photos", "com.snow.android",
        "com.prisma.labs.app", "com.meitu.meipai",
    ],
    "BUSINESS": [
        "com.microsoft.teams", "com.slack",
        "com.zoom.videomeetings", "com.hubspot.android",
        "com.salesforce.android.mobile", "com.docusign.ink",
        "com.concur.breeze", "com.expensify.expensify",
        "com.box.android", "com.ringcentral.android",
    ],
    "MEDICAL": [
        "com.webmd.android", "com.zocdoc.android",
        "com.teladoc.app", "com.mychart.android",
        "com.micromedex.mobilePDR", "com.epocrates",
        "org.redcross.android.redcross", "com.calm.android",
        "com.sharecare.android", "com.imedical.android",
    ],
    "MAPS_AND_NAVIGATION": [
        "com.google.android.apps.maps", "com.waze",
        "com.here.app.maps", "mobi.magealan.wn",
        "com.tomtom.gplay.speedcams", "com.garmin.android.apps.connectmobile",
        "com.citymapper.app.release", "com.trover.android",
        "com.transitapp.transit", "com.moovit.android",
    ],
}
