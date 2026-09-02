// Route-level loading state for the volunteer surface. Sign-up addendum §8.
//
// The host reaches this page on a phone, often on weak signal, sometimes cold
// from a bookmark. Without a loading boundary the tap does nothing visible until
// the server responds, and a host who sees nothing happen taps again.

export default function Loading() {
  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-2xl mx-auto px-4 py-6 animate-pulse">
        <div className="h-3 w-24 rounded bg-gray-800" />
        <div className="h-6 w-48 rounded bg-gray-800 mt-3" />
        <div className="h-3 w-32 rounded bg-gray-900 mt-2" />
        <div className="h-28 rounded-lg bg-gray-900 mt-5" />
        <div className="h-20 rounded-lg bg-gray-900 mt-4" />
      </div>
    </div>
  );
}
