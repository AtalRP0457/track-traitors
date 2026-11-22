import PhoneApp from "@/controller/PhoneApp";
import { t } from "@/shared/strings";

export const metadata = { title: t("meta.playTitle") };

export default function PlayPage() {
  return <PhoneApp />;
}
