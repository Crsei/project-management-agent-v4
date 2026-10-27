import type { PmPageProps } from "./model"
import { NotificationInboxFixture } from "./notification-inbox-fixture"

export function Inbox3FixtureView({ scenario }: PmPageProps) {
  return <NotificationInboxFixture scenario={scenario} />
}
