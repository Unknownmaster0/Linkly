import type { Metadata } from "next";
import { Hero } from "@/components/marketing/hero";
import { HowItWorks } from "@/components/marketing/how-it-works";
import { FeatureGrid } from "@/components/marketing/feature-grid";
import { Audience } from "@/components/marketing/audience";
import { Cta } from "@/components/marketing/cta";
import { APP_DESCRIPTION, APP_NAME, APP_TAGLINE } from "@/lib/config";

export const metadata: Metadata = {
  // `absolute` opts out of the root layout's `%s · Linkly` template for the
  // landing page, which wants the full brand title on its own.
  title: { absolute: `${APP_NAME} — ${APP_TAGLINE}` },
  description: APP_DESCRIPTION,
};

export default function HomePage() {
  return (
    <>
      <Hero />
      <HowItWorks />
      <FeatureGrid />
      <Audience />
      <Cta />
    </>
  );
}
