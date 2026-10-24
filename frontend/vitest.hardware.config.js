/**
 * The hardware-emulator suite runs on its own config, and the reason is a measured fact about the
 * device's HTTP surface — spec 085/110, issue #1593.
 *
 * Speculos answers `POST /apdu` with a CHUNKED response whose first chunk is EMPTY (its Flask
 * handler yields `b""` to force the headers out before the device has replied). jsdom's `fetch`
 * stops there and hands back an empty body, so under the app's default `environment: 'jsdom'`
 * every APDU exchange silently returned nothing — measured: `''` where the device really said
 * `{"data":"9000…"}`. That is the exact failure shape this migration keeps finding, so it is
 * written down rather than worked around: the device suite needs Node's fetch.
 *
 * `src/test/setup.js` is 486 lines of jsdom (window, Element, HTMLCanvasElement) and exists for
 * the component suites; making it node-safe for one file would be a large change to shared
 * infrastructure to serve a test that needs none of it. So this suite gets its own config with NO
 * setup file, and the app's config is untouched.
 *
 *   npm run hw:speculos:up      # emulator + pinned app on the known test seed
 *   npm run test:hw             # this config
 */
import { defineConfig } from 'vite'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/test/hardware/speculosDevice.test.js'],
    // A device round-trip is a real emulated CPU stepping through real firmware; the app's 10s
    // default is a timeout on the hardware, not on the code under test.
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
})
