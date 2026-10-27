"use client";
import { useParams } from "next/navigation";
import { PhotoManager } from "../../../listings/photo-manager";

/** Owner photo manager for one of the owner's investor projects. */
export default function ProjectPhotos() {
  const { id } = useParams<{ id: string }>();
  return (
    <main>
      <p className="inv-back"><a href="/investments/mine">Back to my posted projects</a> · <a href={`/investments/${id}`}>View project</a></p>
      <h1>Project photos</h1>
      <PhotoManager projectId={id} />
    </main>
  );
}
