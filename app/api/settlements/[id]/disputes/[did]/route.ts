import { actionPost, viewGet } from "../../../../../../src/server/dispute-route";
import { withApi } from "../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string; did: string }> };

export const GET = withApi(async (req: Request, { params }: Ctx) => { const p = await params; return viewGet(req, p.id, p.did); });
export const POST = withApi(async (req: Request, { params }: Ctx) => { const p = await params; return actionPost(req, p.id, p.did); });
