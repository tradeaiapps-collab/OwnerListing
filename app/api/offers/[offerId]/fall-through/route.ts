import { fallThroughGet, fallThroughPost } from "../../../../../src/server/fall-through-route";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ offerId: string }> };

/** The buyer's side of "sale fell through": GET the history and what can be done; POST { action: preview | raise | respond | withdraw }. */
async function handleGet(req: Request, { params }: Ctx) { return fallThroughGet(req, (await params).offerId, "buyer"); }
async function handlePost(req: Request, { params }: Ctx) { return fallThroughPost(req, (await params).offerId, "buyer"); }

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
