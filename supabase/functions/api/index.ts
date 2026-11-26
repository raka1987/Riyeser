// The "api" Edge Function: Riyeser's public API. All of it is in handler.ts (tested by api_test.ts); this only serves it.
import { handle } from "./handler.ts";

Deno.serve((req) => handle(req));
