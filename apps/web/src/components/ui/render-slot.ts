import {
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react"

/**
 * Base UI's polymorphic `render` prop, mapped onto Radix's `asChild` child.
 * Trigger children stay inside the rendered element, matching Base UI semantics.
 * The alternate wrapper set is a registered experiment; pages keep one call shape.
 */
export function asChildElement(
  render: ReactNode | undefined,
  children: ReactNode,
): ReactNode {
  if (!isValidElement(render)) return children
  const element = render as ReactElement<Record<string, unknown>>
  if (children === undefined || children === null || children === false)
    return element
  return cloneElement(element, {}, children)
}
