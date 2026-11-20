// A module's shared-page.js as test/web-public-frame.test.js writes it: its options are the test's.
import { startPublicPage } from '../../web/public-frame.js';

startPublicPage(globalThis.publicPage);
