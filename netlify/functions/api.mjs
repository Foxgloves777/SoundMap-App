// The whole API is one function; routing lives in lib/core.mjs.
import { handle } from "../../lib/core.mjs";

export default req => handle(req);

export const config = { path: "/api/*" };
