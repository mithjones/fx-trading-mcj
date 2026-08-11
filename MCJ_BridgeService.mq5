//+------------------------------------------------------------------+
//|                                       MCJ_BridgeService.mq5 v1.00 |
//|                                                                   |
//|  Runs the MCJ Worker bridge permanently, independent of any       |
//|  trading EA.                                                      |
//|                                                                   |
//|  WHY THIS EXISTS                                                  |
//|    The bridge originally lived inside MCJ_ManualTradeManager, but |
//|    that EA is only attached when placing a trade. With it off the  |
//|    chart there is no heartbeat, no trade journaling and no price   |
//|    alert forwarding - so the Suite goes dark exactly when swing    |
//|    positions are running unattended overnight.                     |
//|                                                                   |
//|    This EA has no trading logic, draws nothing, and touches no     |
//|    orders. It just reports.                                        |
//|                                                                   |
//|  IMPORTANT: OnTradeTransaction fires for the WHOLE ACCOUNT, not    |
//|  just the chart symbol. One instance on one chart therefore        |
//|  captures every trade you take on any pair.                        |
//|                                                                   |
//|  SETUP                                                             |
//|    1. Attach to ONE chart only - a spare one you don't trade from  |
//|       (a Daily chart of any pair is ideal).                        |
//|    2. Set BridgeEndpointBase and BridgeApiKey in the Inputs tab.    |
//|       MT5 restores saved per-chart values over file defaults, so    |
//|       check them rather than assuming.                              |
//|    3. Leave it running. Save the chart into your profile so it      |
//|       reloads automatically when MT5 restarts.                      |
//|                                                                    |
//|  Running this alongside the Manual Trade Manager is safe: the      |
//|  Worker rejects duplicate tickets and deal IDs, so a trade          |
//|  reported twice is recorded once.                                   |
//+------------------------------------------------------------------+
#property copyright "MCJ Trading"
#property version   "1.00"
#property description "Reports trades, equity and price alerts to the MCJ Suite. No trading logic."
#property strict

#include <MCJ_WorkerBridge.mqh>

//--- Status label so you can see at a glance that it's alive
#define MCJ_SVC_LABEL "MCJ_BridgeService_Status"

int    g_beats     = 0;
int    g_lastError = 0;

//+------------------------------------------------------------------+
int OnInit()
{
   Print("=== MCJ Bridge Service v1.00 starting ===");
   Print("Endpoint: ", BridgeEndpointBase);
   Print("Account label: ", BridgeAccountLabel);
   Print("Heartbeat every ", BridgeHeartbeatSecs, "s, flush every ", BridgeFlushSeconds, "s");

   if(BridgeApiKey == "")
      Print("MCJ Bridge Service: WARNING - API key is blank, Worker will reject with 401.");
   if(StringFind(BridgeEndpointBase, "mithila") >= 0)
      Print("MCJ Bridge Service: WARNING - endpoint looks like the old placeholder domain.");

   BridgeInit();
   EventSetTimer(BridgeFlushSeconds);

   CreateStatusLabel();
   UpdateStatus("starting...");

   Print("=== MCJ Bridge Service ready ===");
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   EventKillTimer();
   BridgeSaveQueue();          // unsent events survive a restart
   ObjectDelete(0, MCJ_SVC_LABEL);
   Print("MCJ Bridge Service stopped (reason ", reason, ")");
}

//+------------------------------------------------------------------+
void OnTimer()
{
   BridgeFlush();
   BridgeHeartbeat();
   BridgeDrainAlerts();

   g_beats++;
   UpdateStatus(StringFormat("%s  |  equity %.2f  |  %d cycles",
                              TimeToString(TimeCurrent(), TIME_MINUTES),
                              AccountInfoDouble(ACCOUNT_EQUITY),
                              g_beats));
}

//+------------------------------------------------------------------+
//| Account-wide: captures trades placed from any chart, by hand or   |
//| by the Manual Trade Manager.                                       |
//+------------------------------------------------------------------+
void OnTradeTransaction(const MqlTradeTransaction &trans,
                         const MqlTradeRequest    &request,
                         const MqlTradeResult     &result)
{
   BridgeOnTradeTransaction(trans);
}

//+------------------------------------------------------------------+
//| No trading logic - OnTick is deliberately empty so this EA costs   |
//| essentially nothing to leave running.                              |
//+------------------------------------------------------------------+
void OnTick() { }

//+------------------------------------------------------------------+
void CreateStatusLabel()
{
   if(ObjectFind(0, MCJ_SVC_LABEL) >= 0) return;
   ObjectCreate(0, MCJ_SVC_LABEL, OBJ_LABEL, 0, 0, 0);
   ObjectSetInteger(0, MCJ_SVC_LABEL, OBJPROP_CORNER, CORNER_LEFT_LOWER);
   ObjectSetInteger(0, MCJ_SVC_LABEL, OBJPROP_XDISTANCE, 10);
   ObjectSetInteger(0, MCJ_SVC_LABEL, OBJPROP_YDISTANCE, 20);
   ObjectSetInteger(0, MCJ_SVC_LABEL, OBJPROP_FONTSIZE, 8);
   ObjectSetInteger(0, MCJ_SVC_LABEL, OBJPROP_COLOR, clrGray);
   ObjectSetInteger(0, MCJ_SVC_LABEL, OBJPROP_SELECTABLE, false);
}

void UpdateStatus(string s)
{
   ObjectSetString(0, MCJ_SVC_LABEL, OBJPROP_TEXT, "MCJ Bridge: " + s);
   ChartRedraw(0);
}
//+------------------------------------------------------------------+
