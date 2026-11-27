// The "download" Edge Function: counts a riyeser.com download, then sends the browser on to the GitHub file.
// All of it is in handler.ts (tested by download_test.ts); this only serves it.
import { handle } from "./handler.ts";

Deno.serve((req) => handle(req));
