import CohortApp from "../cohort-app"

export default async function JoinPage({
  searchParams,
}: {
  searchParams: Promise<{ invite?: string; room?: string }>
}) {
  const { invite, room } = await searchParams
  return <CohortApp mode="join" code={room || ""} inviteId={invite || ""} />
}
