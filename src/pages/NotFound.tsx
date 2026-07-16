import { Link, useLocation } from "react-router-dom";
import { useEffect } from "react";

const NotFound = () => {
  const location = useLocation();

  useEffect(() => {
    console.error("404 Error: User attempted to access non-existent route:", location.pathname);
  }, [location.pathname]);

  return (
    <div className="flex min-h-[70vh] items-center justify-center">
      <div className="text-center space-y-3">
        <h1 className="font-display text-5xl font-bold">404</h1>
        <p className="text-muted-foreground">That page doesn't exist.</p>
        <Link to="/" className="inline-block text-primary hover:underline">
          Back to the tracker
        </Link>
      </div>
    </div>
  );
};

export default NotFound;
