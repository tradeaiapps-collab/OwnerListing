"use client";
import TemplateEditor from "../../inspector/messages/template-editor";
import "../../styles/staff.css";

/** Platform-wide wording for Elena's inspection confirmations and reminders. Agents can override it for their own drafts. */
export default function StaffSchedulingTemplates() {
  return (
    <main className="insp-page">
      <h1>Elena scheduling messages</h1>
      <p><a href="/staff">Back to staff</a></p>
      <p className="muted">This is the wording Elena uses to draft a confirmation and a 24-hour reminder for each accepted inspection, unless the agent has set their own. Elena only drafts; the agent sends, edits or skips each one.</p>
      <TemplateEditor endpoint="/api/staff/scheduling-templates" scope="platform" />
    </main>
  );
}
