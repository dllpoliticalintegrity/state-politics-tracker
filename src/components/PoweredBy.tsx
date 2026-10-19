// "Powered by the Political Integrity Project" with the PIP logo above it,
// opening each site's hero (state overview and race pages).
import pipLogo from "@/assets/pip-logo.png";

export default function PoweredBy() {
  return (
    <a
      href="https://politicalintegrity.us"
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex flex-col items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground"
    >
      <img src={pipLogo} alt="" width={56} height={56} className="h-14 w-14" />
      Powered by the Political Integrity Project
    </a>
  );
}
