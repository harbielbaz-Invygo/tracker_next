/** invygo wordmark + product name + brand-blue underline. */
export default function BrandHeader() {
  return (
    <div>
      <div className="flex items-baseline gap-3.5 pt-1">
        <span className="brand-wordmark text-[2.4rem] leading-none">invygo</span>
        <span className="text-base font-medium text-ink-500 leading-none pb-0.5">
          Uploading Vehicles Tracker
        </span>
      </div>
      <div className="h-0.5 w-14 bg-brand mt-1 mb-5 rounded" />
    </div>
  );
}
