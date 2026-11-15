import CohortApp from "../../cohort-app"

export default async function RoomPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  return <CohortApp mode="room" code={code} />
}
