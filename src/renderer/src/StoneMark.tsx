import stoneIconUrl from '../../../build/icon.svg?url'

export function StoneMark({ small = false }: { small?: boolean }) {
  return (
    <img
      className={`brand-mark${small ? ' brand-mark--small' : ''}`}
      src={stoneIconUrl}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  )
}
