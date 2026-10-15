import React from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Button, Card } from "../components/ui";
import TicketForm from "../components/tickets/TicketForm";

export default function TicketBookingPage() {
  const navigate = useNavigate();

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-center gap-4">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => navigate("/tickets")}
        >
          <ArrowLeft className="h-4 w-4" />
          Back to tickets
        </Button>
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            Book a ticket
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Add your trip, passengers, and booking details.
          </p>
        </div>
      </div>

      <Card className="p-5 sm:p-7">
        <TicketForm
          mode="create"
          onSave={() => navigate("/tickets", { replace: true })}
          onCancel={() => navigate("/tickets")}
        />
      </Card>
    </div>
  );
}
