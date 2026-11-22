import HostApp from "@/game/HostApp";
import { t } from "@/shared/strings";

export const metadata = { title: t("meta.hostTitle") };

export default function HostPage() {
  return <HostApp />;
}
