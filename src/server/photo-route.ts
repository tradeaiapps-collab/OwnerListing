import { staffCan } from "../domain/staff-access";
import type { GalleryAccess } from "../domain/photo-service";
import { getStaff } from "./context";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Staff with case access may look at draft and hidden photos (moderation). Any lookup error means no staff access. */
export async function staffPhotoAccess(req: Request): Promise<GalleryAccess & { staffId?: string }> {
  try {
    const s = await getStaff(req);
    return s && staffCan(s, "case.manage") ? { staffCanView: true, staffId: s.id } : {};
  } catch {
    return {};
  }
}
