import type { AggregateRelayInput, PublicAccount } from '@shared/types'

type AggregateRelayMember = AggregateRelayInput['members'][number]
type AggregateRelayMemberCandidate = Pick<PublicAccount, 'id' | 'weight'>

export function normalizeAggregateRelayMembers(members: AggregateRelayMember[]): AggregateRelayMember[] {
  return members.map((member, order) => ({ ...member, order }))
}

export function toggleAggregateRelayMember(
  members: AggregateRelayMember[],
  account: AggregateRelayMemberCandidate,
): AggregateRelayMember[] {
  const selected = members.some((member) => member.accountId === account.id)
  return normalizeAggregateRelayMembers(selected
    ? members.filter((member) => member.accountId !== account.id)
    : [...members, { accountId: account.id, order: members.length, weight: account.weight }])
}
