"use client";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { PhotoManager } from "../../../listings/photo-manager";

/** Owner photo manager for one of the owner's investor projects. `?new=1` means the project was just posted. */
export default function ProjectPhotos() {
  const { id } = useParams<{ id: string }>();
  const [fresh, setFresh] = useState(false);
  useEffect(() => { setFresh(new URLSearchParams(window.location.search).get("new") === "1"); }, []);
  return (
    <main>
      <p className="inv-back"><a href="/investments/mine">Back to my posted projects</a> · <a href={`/investments/${id}`}>View project</a></p>
      <h1>Project photos</h1>
      {fresh && (
        <p className="inv-visitor" role="status">
          Your project was posted and is with staff for review. Add photos now to help investors picture it, or <a href={`/investments/${id}`}>skip for now</a>. You can come back any time.
        </p>
      )}
      <PhotoManager projectId={id} />
    </main>
  );
}
