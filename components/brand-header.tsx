/**
 * invygo wordmark + product name, right-aligned for the top-right
 * corner of the content area. Rendered as a compact single line by the
 * authed layout (absolutely positioned top-right) so the page title
 * rises to the top-left instead of sitting beneath a full-width brand
 * block.
 */
export default function BrandHeader() {
  return (
    <div className="flex items-baseline justify-end gap-2.5">
      <span className="brand-wordmark text-2xl leading-none">invygo</span>
      <span className="text-sm font-medium text-ink-500 leading-none">
        Uploading Vehicles Tracker
      </span>
    </div>
  );
}
