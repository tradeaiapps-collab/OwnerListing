import { fallThroughGet, fallThroughPost } from "../../../../../../../src/server/fall-through-route";
import { withApi } from "../../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string; offerId: string }> };

/** The owner's side of "sale fell through" (the listing id in the path is only part of the URL; the owner is found from the offer). */
async function handleGet(req: Request, { params }: Ctx) { return fallThroughGet(req, (await params).offerId, "owner"); }
async function handlePost(req: Request, { params }: Ctx) { return fallThroughPost(req, (await params).offerId, "owner"); }

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
