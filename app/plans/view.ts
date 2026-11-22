export interface PlanView {
  id: string; name: string; maxPhotos: number; storageGb: number; features: string[];
  price: { exGstCents: number; gstCents: number; totalCents: number } | null;
}

export const FEATURE_LABELS: Record<string, string> = {
  video: "Video", photo_360: "360 photos", video_360: "360 video", ai_description: "AI property description",
  ai_auto_reply: "AI enquiry replies", ai_applicant_report: "AI applicant report", contract_drafting: "Contract drafting",
  holiday_portals: "Share on Airbnb, Booking.com and Vrbo"
};

export const money = (cents: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(cents / 100);
