// The "licence" Edge Function. All of it is in handler.ts (tested by sign_test.ts); this only serves it.
import { handle } from "./handler.ts";

Deno.serve((req) => handle(req));
