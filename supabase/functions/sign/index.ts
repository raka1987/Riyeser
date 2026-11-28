// The "sign" Edge Function: the public signing page's server (riyeser.com/sign/?t=…).
// All of it is in handler.ts (tested by sign_test.ts); this only serves it.
import { handle } from "./handler.ts";

Deno.serve((req) => handle(req));
