import { actionPost, viewGet } from "../../../../src/server/settlement-route";
import { withApi } from "../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

async function handleGet(req: Request, { params }: Ctx) { return viewGet(req, (await params).id); }
async function handlePost(req: Request, { params }: Ctx) { return actionPost(req, (await params).id); }

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
