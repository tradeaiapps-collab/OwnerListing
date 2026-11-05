import { createPost, settlementListGet } from "../../../../../src/server/dispute-route";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withApi(async (req: Request, { params }: Ctx) => settlementListGet(req, (await params).id));
export const POST = withApi(async (req: Request, { params }: Ctx) => createPost(req, (await params).id));
