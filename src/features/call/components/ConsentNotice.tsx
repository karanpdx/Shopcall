import { Camera, Image as ImageIcon, Mic, VideoOff } from "lucide-react";

export function ConsentNotice() {
  return (
    <ul className="consent" aria-label="What lit uses during a call">
      <li><Mic size={18} aria-hidden="true" /><span><strong>Microphone</strong> for the conversation with your assistant.</span></li>
      <li><Camera size={18} aria-hidden="true" /><span><strong>Camera is optional.</strong> You can turn it on or off at any time without ending the call.</span></li>
      <li><ImageIcon size={18} aria-hidden="true" /><span>Only the <strong>still photos you capture or upload</strong> are saved to your product drafts.</span></li>
      <li><VideoOff size={18} aria-hidden="true" /><span>lit <strong>does not record full video.</strong> Nothing goes public until you confirm it.</span></li>
    </ul>
  );
}
