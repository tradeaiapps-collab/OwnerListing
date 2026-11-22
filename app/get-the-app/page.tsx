import type { Metadata } from "next";
import { ANDROID_APK_URL, readBrand } from "../../src/config/brand";

export const metadata: Metadata = {
  title: "Get the app",
  description: `Download the ${readBrand().name} Android app for testing, or use the website on any phone.`
};

const ANDROID_APK = ANDROID_APK_URL;

/** Public page with download links for the test builds of the phone app. */
export default function GetTheApp() {
  const brand = readBrand();
  return (
    <main className="legal-page">
      <h1>Get the app</h1>
      <p className="muted">Test builds of the {brand.name} phone app. The app opens this same website, so your account and listings are the same everywhere.</p>

      <section aria-labelledby="android-h">
        <h2 id="android-h">Android</h2>
        <p><a className="btn" href={ANDROID_APK} download>Download the Android app (APK)</a></p>
        <ol>
          <li>Tap the button on your phone and open the downloaded file.</li>
          <li>If Android asks, allow installing from this source (Chrome or Files).</li>
          <li>Tap Install, then open {brand.name}.</li>
        </ol>
        <p className="muted">This is a test build for sideloading. It is not on Google Play yet. If you have an older copy, uninstall it first.</p>
      </section>

      <section aria-labelledby="ios-h">
        <h2 id="ios-h">iPhone</h2>
        <p>There is no iPhone app yet. In Safari, open this site, tap Share, then Add to Home Screen to use it like an app.</p>
      </section>

      <section aria-labelledby="web-h">
        <h2 id="web-h">Any phone or computer</h2>
        <p>No download needed: <a href="/">use the website</a>.</p>
      </section>
    </main>
  );
}
