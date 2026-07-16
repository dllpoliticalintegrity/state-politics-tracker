import { useState } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";

const ORG_NAME = "Political Integrity PAC";
const CONTACT_EMAIL = "donations@politicalintegrity.us";
const WIDGET_ID = "LYOOZ1";

const DonationPanel = () => {
  const [rulesOpen, setRulesOpen] = useState(false);

  return (
    <div className="bg-white text-gray-900">
      <div className="max-w-lg mx-auto px-4 py-6">
        <div className="mb-6 text-gray-600 text-[15px] leading-relaxed space-y-3">
          <p className="text-center">
            The 2026 governor's races will be some of the most expensive elections in
            their states' histories.
          </p>
          <p className="text-center">
            Help us follow the money across the country by becoming a monthly supporter
            of our work.
          </p>
        </div>

        <div className="flex w-full justify-center mb-6">
          <div
            className="w-full max-w-[440px] [&>givebutter-widget]:block [&>givebutter-widget]:w-full"
            dangerouslySetInnerHTML={{ __html: `<givebutter-widget id="${WIDGET_ID}"></givebutter-widget>` }}
          />
        </div>

        <div className="mb-6 text-center">
          <button
            type="button"
            onClick={() => setRulesOpen(true)}
            className="text-xs text-gray-500 underline hover:text-gray-700"
          >
            View contribution rules
          </button>
        </div>

        <div className="text-center text-xs text-gray-400 pb-2">
          <p>Organized by {ORG_NAME}</p>
          <a href={`mailto:${CONTACT_EMAIL}`} className="text-emerald-600 hover:underline">
            {CONTACT_EMAIL}
          </a>
        </div>
      </div>

      <Dialog open={rulesOpen} onOpenChange={setRulesOpen}>
        <DialogContent className="bg-white max-w-lg max-h-[85vh] overflow-y-auto">
          <h4 className="font-semibold text-gray-900 text-sm mb-2">Contribution rules</h4>
          <ol className="text-xs text-gray-500 leading-relaxed space-y-1 list-decimal list-inside">
            <li>I am a U.S. citizen or lawfully admitted permanent resident (i.e., green card holder).</li>
            <li>This contribution is made from my own funds, and funds are not being provided to me by another person or entity for the purpose of making this contribution.</li>
            <li>I am at least eighteen years old.</li>
            <li>I am not a federal contractor.</li>
            <li>I am making this contribution with my own personal credit card and not with a corporate or business credit card or a card issued to another person.</li>
          </ol>
          <p className="text-xs text-gray-400 mt-3 italic">
            Federal law requires us to use our best efforts to collect and report the name, mailing address, occupation and name of employer of individuals whose contributions exceed $200 per election cycle.
          </p>
          <p className="text-xs text-gray-400 mt-3 italic">
            Contributions or gifts to {ORG_NAME} are not tax deductible.
          </p>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default DonationPanel;
