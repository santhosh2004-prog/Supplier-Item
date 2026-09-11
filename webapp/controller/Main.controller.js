sap.ui.define(
  [
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "sap/ui/core/Fragment",
    "sap/m/Link",
    "sap/m/Dialog",
    "sap/m/VBox",
    "sap/m/ObjectHeader",
    "sap/m/ObjectAttribute",
    "sap/m/BusyIndicator",
    "sap/ui/core/HTML",
    "sap/m/Button",
  ],
  function (
    Controller,
    Filter,
    FilterOperator,
    JSONModel,
    MessageToast,
    MessageBox,
    Fragment,
    Link,
    Dialog,
    VBox,
    ObjectHeader,
    ObjectAttribute,
    BusyIndicator,
    HTML,
    Button,
  ) {
    "use strict";

    // Monotonically increasing suffix for the one-shot deferred groups
    // _saveLayoutToBackend creates per call â€" see there for why.
    var oiLayoutSaveCounter = 0;

    /**
     * Fixed set of Vcode bars the Lots received panel's chart always draws,
     * in this order, regardless of which codes the loaded LotRecSet result
     * actually contains â€" see onLotsReceivedPress/_renderLotsReceivedTypeBarChart.
     * A/A1-A5 are "accepted"-style codes; R/R1-R3 are "rejected"-style
     * codes (drawn red). Within the accepted group, A and A4 draw green,
     * the rest (A1/A2/A3/A5) draw the default blue.
     */
    var LOTS_RECEIVED_CODES = [
      "A",
      "A1",
      "A2",
      "A3",
      "A4",
      "A5",
      "R",
      "R1",
      "R2",
      "R3",
    ];

    var COLOR_HEX = [
      "#3979c9",
      "#e0559b",
      "#0f9d78",
      "#8e6fce",
      "#e8791e",
      "#4caf50",
      "#b3261e",
      "#46587f",
      "#8a8d91",
      "#3979c9",
    ];

    /**
     * Column-id translation between this app's internal scheme ("oiCol1"..
     * "oiCol15" â€" what _getOpenItemsCellByColumnId/_applyOpenItemsColumnSelection
     * switch on) and what LayoutSet's Columns field actually stores on the
     * backend for FI ("col1".."col15", confirmed against a live LayoutSet
     * row). Plain string ops, no controller state, so these can be used
     * directly in .map() without a bind.
     *
     * Every category's Save/Select Layout round trip goes through these two
     * (see _mapLayoutSetRow and the payload builder in _saveLayouts), but
     * MM_QM_COLUMN_DEFS's own ids (totalPOTable/pendingPOTable/
     * matReceiptsTable/vendorReturnsTable all use a shared "col1".."col27"
     * numbering, same id = same field wherever it appears across those
     * four tables) are ALREADY in the exact "col<N>" shape LayoutSet
     * stores â€" and, not being controller-internal "oiCol<N>" ids, must
     * NOT be run through the FI oiColN<->colN transform, or a saved MM
     * layout would come back from the backend rewritten to "oiCol1" etc.,
     * which doesn't exist in MM_QM_COLUMN_DEFS, and silently apply zero
     * columns. sCategory is threaded through from both call sites so only
     * FI ids get transformed; MM/QM ids pass through unchanged in both
     * directions, since they're already the on-the-wire format.
     */
    function oiColIdToBackend(sOiColId, sCategory) {
      // "oiCol1" -> "col1", FI only. MM/QM's own "col<N>" ids go out as-is.
      return sCategory === "FI" && /^oiCol\d+$/.test(sOiColId)
        ? sOiColId.slice(2).toLowerCase()
        : sOiColId;
    }
    function backendColIdToOi(sBackendColId, sCategory) {
      // "col1" -> "oiCol1", FI only. MM/QM's own "col<N>" ids come back as-is.
      return sCategory === "FI" && /^col\d+$/.test(sBackendColId)
        ? "oi" +
            sBackendColId.charAt(0).toUpperCase() +
            sBackendColId.slice(1).toLowerCase()
        : sBackendColId;
    }

    return Controller.extend("supplieropenitems.controller.main", {
      getPercentageColor: function (value) {


    if (Number(value) >= 100) {
        return "greenCell";
    }

    return "redCell";
},
      /**
       * Everything onInit used to do EXCEPT the final this.onSearch() call â€"
       * pulled out so Detail.controller.js (the routed master-detail page,
       * Routedetail) can run the exact same model/column-map/saved-layout
       * setup from its own onInit, then run its own route-driven load
       * instead of onSearch's plain-dashboard search. Single source of
       * truth for that setup instead of two copies drifting apart.
       */
      _initCommon: function () {
        this._oReconModel = new JSONModel({
          items: [],
          donut: [],
          count: 0,
          busy: false,
          sidebarBusy: false,
          masterDetailMode: false,
          openingBalanceValue: 0,
          mdPaymentsValue: "â‚¹45.6L",
          mdVsPriorPercent: null,
          matF4Items: [],
          matF4Busy: false,
          sobSelectedMaterials: [],
          sobAllTotalShareBusinessItems: [],
        });
        this.getView().setModel(this._oReconModel, "recon");

        this.getView().setModel(
          new JSONModel({ results: [] }),
          "compCodeModel",
        );
        this.getView().setModel(
          new JSONModel({ results: [] }),
          "supplierModel",
        );
        this._oCompCodeDialog = null;
        this._oSupplierDialog = null;
        this._oPaymentsDialog = null;

        // Land on the page pre-filled with Company Code 1000, From Date =
        // start of the current financial year (1 April â€" e.g. today in
        // Jan-Mar 2026 means FY start is 01.04.2025, not 01.04.2026), and
        // To Date = that same financial-year start too â€" but only for
        // Opening Balance, the panel this initial load lands on. The first
        // time any OTHER panel (Advance, Debit Notes, ...) is opened this
        // session, _showMdPanel swaps To Date to today instead, as long as
        // it's still sitting at this untouched FY-start default (see
        // _sFyStartDefault/_bToDateAdjustedForOtherPanel there) â€" then runs
        // the same search Go would. The fields stay fully editable
        // throughout; this just saves the user the first Go click.
        var oToday = new Date();

        var iFyStartYear =
          oToday.getMonth() >= 3 // getMonth() is 0-based; 3 = April
            ? oToday.getFullYear()
            : oToday.getFullYear() - 1;
        var sFyStart = this._toIsoDate(new Date(iFyStartYear, 3, 1));
        this._sFyStartDefault = sFyStart;
        this._bToDateAdjustedForOtherPanel = false;

        this.byId("inputBukrs").setValue("1000");
        this.byId("inputKeyDate").setValue(sFyStart);
        this.byId("inputKeyDateTo").setValue(sFyStart);

        // Remembers which Finance/Materials row is currently open in the
        // master-detail right panel ("opening" | "transactions" | "advance"
        // | "debitnotes" | "payments" | "generic"), so that re-running the
        // search with new dates (Go) re-loads the SAME panel instead of
        // silently dropping back to Opening balance. Only a fresh page load
        // (this initial value) defaults to Opening balance â€" overwritten
        // right below by _restoreUiState() if a previous session's state
        // (Company Code/Supplier/dates/panel â€" e.g. after saving a layout,
        // setting one as default, or creating a new one) was persisted.
        this._sActiveMdPanel = "opening";
        this._sActiveMdPanelLabel = "";

        // Restores whatever page the user was on (Company Code, Supplier,
        // date range, and which Finance/Materials/Quality panel was open)
        // from sessionStorage, so saving/creating a layout or setting one
        // as Default and then refreshing the browser lands back on the
        // exact same page instead of resetting to Opening balance with the
        // default FY dates. State is (re-)persisted every time any of those
        // fields actually changes â€" see _persistUiState.
        this._restoreUiState();

        // Column Settings / Select Layout for the Opening balance "Line
        // items" grid table (masterDetailTable) â€" picker+reorder+save,
        // persisted server-side via LayoutSet (see _ensureLayoutsLoadedForCategory).
        this._oiColumnMap = [
          { id: "oiCol1", label: "Document" },
          { id: "oiCol2", label: "Date" },
          { id: "oiCol3", label: "Type" },
          { id: "oiCol4", label: "Amount" },
          { id: "oiCol5", label: "Status" },
          { id: "oiCol6", label: "Company Code" },
          { id: "oiCol7", label: "Supplier" },
          { id: "oiCol8", label: "Supplier Name" },
          { id: "oiCol9", label: "Text" },
          { id: "oiCol10", label: "Reference" },
          { id: "oiCol11", label: "Currency" },
          { id: "oiCol12", label: "Posting Status" },
          { id: "oiCol13", label: "Document Date" },
          { id: "oiCol14", label: "Special G/L Ind" },
          { id: "oiCol15", label: "Debit/Credit" },
        ];
        this.getView().setModel(
          new JSONModel({ columns: this._oiColumnMap }),
          "oiColumnModel",
        );

        // Multi-select checkbox Filter button next to Column Settings/Select
        // Layout â€" label + fixed list of {key, text} values to show, per
        // table id. Only tables listed here get a working Filter button.
        // Selection is tracked but NOT yet applied to the table (see
        // onOpenItemsFilterSelectionChange).
        this._oiFilterFieldMap = {
          transactionsTable: {
            label: "Items",
            values: [
              { key: "All", text: "All" },
              { key: "Normal", text: "Normal Items" },
              { key: "SplGL", text: "Spl GL Items" },
              { key: "Noted", text: "Noted Items" },
              { key: "Parked", text: "Parked Items" },
              { key: "Customer", text: "Customer Items" },
            ],
          },
        };
        // Saved layouts are now scoped by Category (FI/MM/QM) â€" see
        // TABLE_CATEGORY/_ensureLayoutsLoadedForCategory further down. All
        // three categories' lists load (and each one's Default applies)
        // right away at startup, same as FI always did â€" MM/QM used to load
        // lazily only the first time their Column Settings/Select Layout
        // dialog opened, which meant a saved MM/QM default layout never
        // took effect until the user had already opened that dialog once
        // this session. _applyDefaultOpenItemsLayoutForCategory now
        // broadcasts to every table in the category (skipping any not yet
        // in the DOM), so this eager load is enough to apply saved MM/QM
        // layouts up front too.
        this._oiSavedLayoutsByCategory = {};
        this._sActiveOiCategory = "FI";
        this._ensureLayoutsLoadedForCategory("FI");
        this._ensureLayoutsLoadedForCategory("MM");
        this._ensureLayoutsLoadedForCategory("QM");
      },

      onInit: function () {
        this._initCommon();
        this.onSearch();
      },

      /**
       * sessionStorage key used to remember Company Code/Supplier/date
       * range and which Finance/Materials/Quality panel is open, so a
       * browser refresh (or the tab being reopened this session) can land
       * back on the same page instead of resetting to Opening balance â€"
       * see _persistUiState/_restoreUiState. sessionStorage (not
       * localStorage) so this only survives within the current tab/session,
       * not indefinitely across unrelated future visits.
       */
      UI_STATE_STORAGE_KEY: "supplierOpenItems.uiState",

      /**
       * Snapshots the current Company Code/Supplier/date-range inputs and
       * the active master-detail panel to sessionStorage. Called every time
       * this._sActiveMdPanel is set (i.e. whenever the user switches panels)
       * so the snapshot is always current by the time anything â€" a Save
       * Layout, a Set as Default, or a plain browser refresh â€" might need
       * to restore it. Silently no-ops if sessionStorage isn't available
       * (e.g. private browsing in some browsers) rather than throwing.
       */
     
      _persistUiState: function () {
        try {
          var oInputBukrs = this.byId("inputBukrs");
          var oInputLifnr = this.byId("inputLifnr");
          var oInputKeyDate = this.byId("inputKeyDate");
          var oInputKeyDateTo = this.byId("inputKeyDateTo");
          if (!oInputBukrs || !oInputLifnr || !oInputKeyDate || !oInputKeyDateTo) {
            return;
          }
          window.sessionStorage.setItem(
            this.UI_STATE_STORAGE_KEY,
            JSON.stringify({
              bukrs: oInputBukrs.getValue(),
              lifnr: oInputLifnr.getValue(),
              keyDate: oInputKeyDate.getValue(),
              keyDateTo: oInputKeyDateTo.getValue(),
              activePanel: this._sActiveMdPanel,
              activePanelLabel: this._sActiveMdPanelLabel || "",
            }),
          );
        } catch (e) {
          // sessionStorage unavailable/full â€" staying on the default page
          // after a refresh is a much smaller problem than crashing onInit.
        }
      },

      /**
       * Restores whatever was last snapshotted by _persistUiState, if
       * anything, overwriting onInit's hardcoded Company Code 1000/current
       * FY dates and the "opening" panel default. Only fills in fields the
       * saved state actually has a value for, so a partial/corrupt snapshot
       * can't blank out fields onInit already set. Called once from onInit,
       * before the initial onSearch() runs.
       */
      /**
       * One-shot sessionStorage flag: set immediately before a reload that
       * our OWN code triggers intentionally (Save Layout / Set as Default,
       * both funnel through onRefreshPage's window.location.reload()) so
       * _shouldRestoreUiState can tell "we just reloaded the page on
       * purpose to reflect a save" apart from every other reload, and
       * always restore in that case regardless of the window.top check
       * below. Consumed (removed) the moment it's read, so it only ever
       * applies to the very next load.
       */
      ALLOW_RESTORE_ONCE_KEY: "supplierOpenItems.allowRestoreOnce",

      /**
       * Decides whether _restoreUiState should repopulate Company Code/
       * Supplier/dates/active panel from sessionStorage, or leave onInit's
       * fresh defaults in place. Three situations, three different answers:
       *
       * 1. Save Layout / Set as Default (onRefreshPage) â€" ALWAYS restore.
       *    These call window.location.reload() themselves specifically so
       *    the saved layout takes effect from a clean onInit; losing the
       *    user's Company Code/Supplier/panel on top of that would be a
       *    regression, not a fresh start. Detected via ALLOW_RESTORE_ONCE_KEY,
       *    which onRefreshPage sets right before reloading (see below).
       *
       * 2. A genuine manual browser refresh (F5 / Ctrl+R / reload button) â€"
       *    restore, matching the original "refresh brings you back to where
       *    you were" behaviour.
       *
       * 3. The FLP shell's own "back" button / relaunching the app tile â€"
       *    do NOT restore; land on fresh defaults instead.
       *
       * Distinguishing (2) from (3) is the tricky part: when this app runs
       * inside the shell's iframe (the normal FLP app-hosting model), the
       * shell's back/relaunch only reloads THIS app's iframe â€" the shell's
       * own top-level document is untouched â€" whereas a real F5 reloads the
       * whole browser tab, top document included. So a flag stashed on
       * window.top survives case (3) (the shell page never reloaded) but
       * gets wiped in case (2) (the whole tab, and therefore window.top,
       * reloaded from scratch). A plain `window`-level flag can't tell
       * these apart, since it resets to a fresh JS context either way (this
       * app's own iframe reloading is exactly what the flag would see for
       * BOTH cases) â€" window.top is the one thing that only a real full-tab
       * reload actually clears.
       *
       * Falls back to the same-window flag if window.top isn't reachable
       * (e.g. a cross-origin shell) rather than never restoring at all.
       */
      _shouldRestoreUiState: function () {
        try {
          if (window.sessionStorage.getItem(this.ALLOW_RESTORE_ONCE_KEY)) {
            window.sessionStorage.removeItem(this.ALLOW_RESTORE_ONCE_KEY);
            return true;
          }
        } catch (e) {
          // sessionStorage unavailable â€" fall through to the window.top check.
        }

        try {
          var oTopWindow = window.top;
          if (oTopWindow.__supplierOpenItemsUiStateInit) {
            return false;
          }
          oTopWindow.__supplierOpenItemsUiStateInit = true;
          return true;
        } catch (e) {
          // Cross-origin window.top â€" fall back to the same-window flag
          // (won't distinguish shell-back from a real reload in that setup,
          // but that's the same limitation the app already had before this
          // check existed, not a new regression).
          if (window.__supplierOpenItemsUiStateInit) {
            return false;
          }
          window.__supplierOpenItemsUiStateInit = true;
          return true;
        }
      },

      _restoreUiState: function () {
        try {
          // See _shouldRestoreUiState for why a genuine refresh and a
          // Save-Layout/Set-Default reload both restore, while the FLP
          // shell's own back navigation does not.
          if (!this._shouldRestoreUiState()) return;

          var sRaw = window.sessionStorage.getItem(this.UI_STATE_STORAGE_KEY);
          if (!sRaw) return;
          var oState = JSON.parse(sRaw);
          if (!oState) return;

          if (oState.bukrs) this.byId("inputBukrs").setValue(oState.bukrs);
          if (oState.lifnr) this.byId("inputLifnr").setValue(oState.lifnr);
          if (oState.keyDate) this.byId("inputKeyDate").setValue(oState.keyDate);
          if (oState.keyDateTo) this.byId("inputKeyDateTo").setValue(oState.keyDateTo);
          if (oState.activePanel) this._sActiveMdPanel = oState.activePanel;
          this._sActiveMdPanelLabel = oState.activePanelLabel || "";
        } catch (e) {
          // Corrupt/inaccessible sessionStorage â€" just keep onInit's
          // hardcoded defaults instead of crashing onInit.
        }
      },

      /** Formats a Date as "yyyy-MM-dd", matching the DatePickers' valueFormat. */
      _toIsoDate: function (oDate) {
        return (
          oDate.getFullYear() +
          "-" +
          String(oDate.getMonth() + 1).padStart(2, "0") +
          "-" +
          String(oDate.getDate()).padStart(2, "0")
        );
      },

      /**
       * Every master-detail module panel (Transactions, Advance balance,
       * Accepted qty, Rejected qty, ...) is shown/hidden via its own
       * "mdShowXxx" boolean on the recon model, and each one's fragment
       * binds its own visible="{recon>/mdShowXxx}" independently — the
       * "Opening balance"/Line items panel is simply the state where NONE
       * of them are true (see OpenItemsPanel.fragment.xml's visible
       * condition). Every press handler therefore has to flip its own flag
       * true AND every other one false, in the same tick, or two panels'
       * fragments (and their sap.ui.table Tables) end up visible at once —
       * which is exactly what was happening: several handlers (Transactions,
       * Payments, Rejected qty, ...) had grown an incomplete copy-pasted
       * reset list over time and were missing one or more of the other
       * flags, so switching TO that module could leave a PREVIOUS module's
       * panel still mounted underneath it.
       *
       * Centralizing the full flag list here (used by every onXxxPress
       * handler below instead of each hand-rolling its own reset block)
       * makes that whole bug class structurally impossible going forward —
       * there's exactly one place that needs to know the complete list.
       * Pass null/undefined to hide every module panel (back to Opening
       * balance/Line items). sap.ui.getCore().applyChanges() forces the
       * visibility change to flush to the DOM synchronously, before the
       * panel's own OData read fires, so there's no frame where the old
       * panel could still be painted.
       */
      MD_SHOW_FLAGS: [
        "mdShowGenericModule",
        "mdShowTransactions",
        "mdShowAdvance",
        "mdShowDebitNotes",
        "mdShowPendingInvoices",
        "mdShowTotalPO",
        "mdShowPendingPO",
        "mdShowLotsAccepted",
        "mdShowLotsReceived",
        "mdShowAcceptedQty",
        "mdShowRejectedQty",
        "mdShowAudQty",
        "mdShowShareOfBusiness",
        "mdShowMatReceipts",
        "mdShowVendorReturns",
        "mdShowPayments",
        "mdShowClosingBalance",
      ],

      _showMdPanel: function (sActiveFlag) {
        var oReconModel = this._oReconModel;
        this.MD_SHOW_FLAGS.forEach(function (sFlag) {
          oReconModel.setProperty("/" + sFlag, sFlag === sActiveFlag);
        });

        // onInit defaults To Date to the financial-year start, but that's
        // meant for Opening Balance only (sActiveFlag === null â€" see
        // onOpeningBalancePress's _showMdPanel(null)). The first time any
        // other panel opens this session, swap To Date to today instead â€"
        // but only if it's still sitting at that untouched FY-start
        // default (a user who already ran a Go with a different date, or
        // whose session restored a saved date, is left alone), and only
        // once per session so it doesn't keep re-adjusting every time the
        // user switches panels back and forth.
        if (
          sActiveFlag !== null &&
          !this._bToDateAdjustedForOtherPanel &&
          this._sKeyDateTo === this._sFyStartDefault
        ) {
          var sTodayIso = this._toIsoDate(new Date());
          this._sKeyDateTo = sTodayIso;
          var oInputKeyDateTo = this.byId("inputKeyDateTo");
          if (oInputKeyDateTo) {
            oInputKeyDateTo.setValue(sTodayIso);
          }
          this._bToDateAdjustedForOtherPanel = true;
        }

        // Supplier (Main.view.xml's inputLifnr) is only locked while the
        // Total Qty Breakdown view is active â€" switching to ANY panel
        // (Opening Balance, Debit Notes, Payments, Refresh, ...) must
        // release that lock. onShareOfBusinessPress/_loadShareLifnrBreakdown
        // already reset this explicitly when landing back on Share of
        // Business itself; _loadTotalShareBusinessBreakdown sets it true
        // again right after this call runs (mdShowShareOfBusiness's own
        // _showMdPanel call happens first in onShareOfBusinessPress).
        if (sActiveFlag !== "mdShowShareOfBusiness") {
          oReconModel.setProperty("/totalShareBusinessActive", false);
        }
        sap.ui.getCore().applyChanges();
      },

      /**
       * Fired from the back button on the master-detail (Supplier) panel.
       * Clears the Supplier field and re-runs the search, which drops the
       * page back into the Chart view for the current Company Code/dates.
       */
      onBackToChart: function () {
        this.byId("inputLifnr").setValue("");
        this._sActiveMdPanel = "opening"; this._persistUiState();
        this._sActiveMdPanelLabel = "";
        this.onSearch();
      },
      
      onMdLeftPanelMenuPress: function () {
        var oReconModel = this._oReconModel;
        var bOpen = oReconModel.getProperty("/mdLeftPanelOpen");
        oReconModel.setProperty("/mdLeftPanelOpen", !bOpen);
      },

      /**
       * Fired when the "Opening balance" row in the master-detail
       * Finance (FI) panel is clicked. Calls OpBalAsOnSet for the
       * currently loaded Company Code / Supplier / key date.
       */
      onOpeningBalancePress: function () {
        this._sActiveMdPanel = "opening"; this._persistUiState();
        // To Date defaults to the financial-year start for Opening Balance
        // specifically (see onInit/_showMdPanel) â€" every time the user
        // comes back to this row, not just on the very first load, so
        // leaving another panel (which swaps To Date to today) and
        // returning here always shows the FY start again, not whatever
        // date was left over from that other panel.
        if (this._sFyStartDefault) {
          this._sKeyDateTo = this._sFyStartDefault;
          var oInputKeyDateTo = this.byId("inputKeyDateTo");
          if (oInputKeyDateTo) {
            oInputKeyDateTo.setValue(this._sFyStartDefault);
          }
          this._bToDateAdjustedForOtherPanel = false;
        }
        var sBukrs = this._sBukrs;
        var sLifnr = this._oReconModel.getProperty("/mdLifnr");
        // OpBalAsOnSet is "balance as on <date>" â€" that date is the To
        // Date the user searched with (falling back to From Date when no
        // To Date was entered), not the From Date.
        var sKeyDate = this._sKeyDateTo || this._sKeyDate;

        if (!sBukrs || !sLifnr || !sKeyDate) {
          MessageToast.show(
            "Company Code, Supplier and From Date are required.",
          );
          return;
        }

        var oModel = this.getOwnerComponent().getModel();
        var oReconModel = this._oReconModel;
        var aFilters = [
          new Filter("Bukrs", FilterOperator.EQ, sBukrs),
          new Filter("Lifnr", FilterOperator.EQ, sLifnr),
          new Filter("Budat", FilterOperator.EQ, new Date(sKeyDate)),
        ];

        oReconModel.setProperty("/openItemsBusy", true);
        this._showMdPanel(null);

        oModel.read("/OpBalAsOnSet", {
          filters: aFilters,
          success: function (oData) {
            var aResults = oData.results || [];
            if (aResults.length === 0) {
              MessageToast.show("No opening balance items found.");
            }

            var fBalance = 0;
            var aItems = aResults.map(function (o) {
              var fDmbtr = parseFloat(o.Dmbtr) || 0;
              var fSignedAmt = o.Shkzg === "H" ? -fDmbtr : fDmbtr;
              fBalance += fSignedAmt;
              return {
                Belnr: o.Belnr,
                Budat: o.Budat,
                // OpBalAsOnSet's field is spelled "Docty_dese" (typo baked
                // into the backend) â€" not "Docty_desc" like the other
                // entity sets. Confirmed against a live OpBalAsOnSet
                // response.
                Blart: o.Docty_dese || o.Blart,
                NetAmt: fSignedAmt,
                Augbl: o.Augdt,
                Bukrs: o.Bukrs,
                Lifnr: o.Lifnr,
                Name1: o.Name1,
                Sgtxt: o.Sgtxt,
                Rebzg: o.Rebzg,
                Waers: o.Waers,
                Bstat: o.Bstat,
                Bldat: o.Bldat,
                Umskz: o.Umskz,
                Shkzg: o.Shkzg,
              };
            });

            oReconModel.setProperty("/openItems", aItems);
            oReconModel.setProperty("/openingBalanceValue", fBalance);
            oReconModel.setProperty("/openItemsBusy", false);
          },
          error: function (oError) {
            // Same "Data is not Found" business exception handled in
            // _loadSupplierMasterDetail â€" treat as no data, not a real error.
            var bNoDataFound = false;
            try {
              var oBody = JSON.parse(oError.responseText);
              bNoDataFound =
                !!oBody.error &&
                oBody.error.code === "/IWBEP/CM_MGW_RT/022";
            } catch (e) {
              bNoDataFound = false;
            }

            oReconModel.setProperty("/openItems", []);
            oReconModel.setProperty("/openingBalanceValue", 0);
            oReconModel.setProperty("/openItemsBusy", false);

            if (!bNoDataFound) {
              MessageToast.show("Error loading opening balance.");
            }
          },
        });
      },

      onSearch: function () {
        var sBukrs = this.byId("inputBukrs").getValue().trim();
        // The Supplier field displays "code - Name" once a search has
        // resolved a name (see _loadSupplierMasterDetail) â€" only the code
        // before " - " is a valid filter value, so strip the name back off
        // before using it.
        var sLifnr = this.byId("inputLifnr")
          .getValue()
          .trim()
          .split(" - ")[0]
          .trim();
        var sKeyDate = this.byId("inputKeyDate").getValue().trim();
        var sKeyDateTo = this.byId("inputKeyDateTo").getValue().trim();

        if (!sBukrs) {
          MessageToast.show("Please enter a Company Code.");
          return;
        }
        if (!sKeyDateTo) {
          MessageToast.show("Please enter a From Date.");
          return;
        }
        // Opening Balance/Advance Balance/Pending Invoices don't filter by
        // From Date at all (see isFromDateEnabled) â€" only To Date matters
        // there, so a From Date left over from a different panel (or just
        // never touched) shouldn't block the search with an error about a
        // field these three panels don't even use. Gated on masterDetailMode
        // too: _sActiveMdPanel defaults to "opening" from onInit as a "which
        // panel to reload" hint even before any supplier's been drilled
        // into, so without this gate every very-first search (still on the
        // chart/vendor list, no panel actually open yet) would also skip
        // the check.
        var bFromDateIgnoredForActivePanel =
          this._oReconModel.getProperty("/masterDetailMode") &&
          (this._sActiveMdPanel === "opening" ||
            this._sActiveMdPanel === "advance" ||
            this._sActiveMdPanel === "pendinginvoices");

        if (
          !bFromDateIgnoredForActivePanel &&
          sKeyDateTo &&
          new Date(sKeyDateTo) < new Date(sKeyDate)
        ) {
          MessageToast.show("To Date cannot be before From Date.");
          return;
        }

        this._sBukrs = sBukrs;
        this._sKeyDate = sKeyDate;
        this._sKeyDateTo = sKeyDateTo || null;
        this._sSelectedAkont = null;

        // A Supplier NO alongside the Company Code + date range switches into
        // the master-detail layout (Finance/Materials/Quality panel + line
        // items) â€" that's its own routed page (Detail.view.xml/Routedetail)
        // now, not a mode flag on this view, so this navigates there instead
        // of loading it inline. Company Code/Supplier/date range travel as
        // route params (URL-encoded); Detail.controller.js's route-matched
        // handler reads them back and calls the very same
        // _loadSupplierMasterDetail this used to call directly (inherited
        // unchanged from this controller). Pressing Go again from the Detail
        // page itself (same .onSearch handler, inherited) re-navigates with
        // whatever new dates were entered, which re-fires patternMatched and
        // reloads â€" so Go behaves identically on both pages.
        if (sLifnr) {
          this.getOwnerComponent()
            .getRouter()
            .navTo("Routedetail", {
              bukrs: encodeURIComponent(sBukrs),
              lifnr: encodeURIComponent(sLifnr),
              fromdate: encodeURIComponent(sKeyDate || ""),
              todate: encodeURIComponent(sKeyDateTo || sKeyDate || ""),
            });
          return;
        }

        // No Supplier: this is the plain chart/dashboard search, which only
        // exists on THIS view (Main/Routemain) â€" e.g. Supplier was cleared
        // via "Back to Chart" while sitting on the Detail page mid-navigation.
        // Everything below reaches into Main.view.xml-only controls
        // (dashboardTabHeader, mainScrollContainer, ...) via byId, so if
        // we're not actually on that view, navigate there first instead of
        // letting those byId calls fail against Detail.view.xml's controls.
        // Checked via a control id unique to Main.view.xml (its root Page,
        // "dynamicPage") rather than getViewName() â€" manifest.json registers
        // this view as "main" (lowercase), not "Main", so a string compare
        // against the view name is one easy typo away from silently always
        // failing and redirecting on every load.
        if (!this.byId("dynamicPage")) {
          this.getOwnerComponent().getRouter().navTo("Routemain");
          return;
        }

        this._oReconModel.setData({
          items: [],
          donut: [],
          count: 0,
          totals: { invAmt: 0, advAmt: 0, netAmt: 0 },
          busy: true,
          vendorsBusy: false,
          selectedCategory: "",
          openItems: [],
          openItemsBusy: false,
          selectedVendor: "",
          kpiTiles: {
            re: { count: 0, invAmt: 0, netAmt: 0 },
            other: { count: 0, invAmt: 0, netAmt: 0 },
          },
          masterDetailMode: false,
        });

        var oModel = this.getOwnerComponent().getModel();
        var that = this;

        var aFilters = [
          new Filter("Bukrs", FilterOperator.EQ, sBukrs),
          this._getBudatFilter("Budat"),
        ];

        oModel.read("/ReconSet", {
          filters: aFilters,
          success: function (oData) {
            var aResults = oData.results || [];
            if (aResults.length === 0) {
              MessageToast.show("No reconciliation records found.");
            }
            that._buildDonutData(aResults);
          },
          error: function () {
            that._oReconModel.setProperty("/busy", false);
            MessageToast.show("Error loading data.");
          },
        });
      },

      /**
       * Loads OpBalAsOnSet for a directly-entered Supplier (no category
       * drill-down needed) and switches the page into the master-detail
       * layout: a static Finance/Materials/Quality summary panel on the left
       * (dummy data â€" no backend for these yet) and the real line items
       * table on the right. Both the "Balance value" tile and the Line
       * items table are driven entirely by OpBalAsOnSet â€" OpenItemsSet is
       * not used on this page.
       */
      _loadSupplierMasterDetail: function (
        sBukrs,
        sLifnr,
        sKeyDate,
        sKeyDateTo,
      ) {
        var oModel = this.getOwnerComponent().getModel();
        var oReconModel = this._oReconModel;
        var that = this;

        var sPeriodLabel = sKeyDateTo
          ? this.formatDisplayDate(sKeyDate) +
            " - " +
            this.formatDisplayDate(sKeyDateTo)
          : this.formatDisplayDate(sKeyDate);

        oReconModel.setData({
          items: [],
          donut: [],
          count: 0,
          totals: { invAmt: 0, advAmt: 0, netAmt: 0 },
          busy: true,
          vendorsBusy: false,
          selectedCategory: "",
          openItems: [],
          openItemsAll: [],
          openItemsBusy: true,
          selectedVendor: sLifnr,
          kpiTiles: {
            re: { count: 0, invAmt: 0, netAmt: 0 },
            other: { count: 0, invAmt: 0, netAmt: 0 },
          },
          masterDetailMode: true,
          mdLeftPanelOpen: true,
          mdBukrs: sBukrs,
          mdLifnr: sLifnr,
          mdSupplierName: "",
          mdPeriodLabel: sPeriodLabel,
          mdBarChartRangeLabel: "",
          mdSelectedMonthLabel: "",
          mdVsPriorPercent: null,
          mdPaymentsValue: "â‚¹45.6L",
          mdShowPayments: false,
          mdShowTransactions: false,
          mdShowGenericModule: false,
          mdGenericModuleLabel: "",
          mdShowAdvance: false,
          advanceItems: [],
          advanceTotal: 0,
          advanceBusy: false,
          mdShowDebitNotes: false,
          debitNotesItems: [],
          debitNotesTotal: 0,
          debitNotesBusy: false,
          mdShowPendingInvoices: false,
          pendingInvoicesItems: [],
          pendingInvoicesTotal: 0,
          pendingInvoicesBusy: false,
          mdShowTotalPO: false,
          totalPOItems: [],
          totalPOItemsAll: [],
          totalPOTotal: 0,
          totalPOQty: 0,
          totalPOTypeTotals: [],
          mdTotalPOSelectedCategory: null,
          totalPOMaterialOptions: [],
          totalPOSelectedMaterials: [],
          lotsAcceptedItemsAll: [],
          lotsAcceptedTypeTotals: [],
          mdLotsAcceptedSelectedCategory: null,
          audQtyItems: [],
          audQtyItemsAll: [],
          audQtyTotal: 0,
          audQtyTypeTotals: [],
          audQtyBusy: false,
          audQtySupplierName: "",
          audQtyCount: 0,
          mdAudQtySelectedCategory: null,
          mdShowShareOfBusiness: false,
          shareOfBusinessItems: [],
          shareOfBusinessBusy: false,
          shareOfBusinessSupplierName: "",
          shareLifnrItems: [],
          shareLifnrBusy: false,
          shareLifnrLabel: "",
          shareOfBusinessQtyPercent: "",
          totalShareBusinessItems: [],
          totalShareBusinessBusy: false,
          totalShareBusinessLabel: "",
          totalShareBusinessActive: false,
          lotsAcceptedCount: 0,
          lotsReceivedCount: 0,
          rejectedQtyCount: 0,
          matReceiptsItems: [],
          matReceiptsTotal: 0,
          matReceiptsBusy: false,
          matReceiptsSupplierName: "",
          vendorReturnsItems: [],
          vendorReturnsTotal: 0,
          vendorReturnsCount: 0,
          vendorReturnsBusy: false,
          vendorReturnsSupplierName: "",
          totalPOBusy: false,
          totalPOSupplierName: "",
          mdShowPendingPO: false,
          pendingPOItems: [],
          pendingPOItemsAll: [],
          pendingPOTotal: 0,
          pendingPOQty: 0,
          advanceContractTotal: 0,
          advanceContractQty: 0,
          pendingPOTypeTotals: [],
          mdPendingPOSelectedCategory: null,
          pendingPOBusy: false,
          pendingPOSupplierName: "",
          mdShowLotsReceived: false,
          lotsReceivedItems: [],
          lotsReceivedItemsAll: [],
          lotsReceivedTotal: 0,
          lotsReceivedTypeTotals: [],
          lotsReceivedBusy: false,
          lotsReceivedSupplierName: "",
          mdLotsReceivedSelectedCategory: null,
          mdShowLotsAccepted: false,
          lotsAcceptedItems: [],
          lotsAcceptedTotal: 0,
          lotsAcceptedBusy: false,
          lotsAcceptedSupplierName: "",
          mdShowRejectedQty: false,
          mdShowAudQty: false,
          mdShowMatReceipts: false,
          mdShowVendorReturns: false,
          rejectedQtyItems: [],
          rejectedQtyTotal: 0,
          rejectedQtyBusy: false,
          rejectedQtySupplierName: "",
          mdShowAcceptedQty: false,
          acceptedQtyItems: [],
          acceptedQtyTotal: 0,
          acceptedQtyCount: 0,
          acceptedQtyBusy: false,
          acceptedQtySupplierName: "",
          transactionItems: [],
          transactionsAll: [],
          transactionsTotal: 0,
          transactionsBusy: false,
          paymentsItems: [],
          paymentsBusy: false,
          paymentsItemsAll: [],
          paymentsTypeTotals: [],
          mdPaymentsSelectedCategory: null,
          paymentsTotal: 0,
          mdPaymentsPeriodLabel: "",
          openingBalanceValue: 0,
          openItemsTotal: 0,
        });

        // OpBalAsOnSet is "balance as on <date>" â€" that date is the To
        // Date the user searched with (falling back to From Date when no
        // To Date was entered), not the From Date.
        var aFilters = [
          new Filter("Bukrs", FilterOperator.EQ, sBukrs),
          new Filter("Lifnr", FilterOperator.EQ, sLifnr),
          new Filter("Budat", FilterOperator.EQ, new Date(sKeyDateTo || sKeyDate)),
        ];

        oModel.read("/OpBalAsOnSet", {
          filters: aFilters,
          success: function (oData) {
            var aRawResults = oData.results || [];
            if (aRawResults.length === 0) {
              MessageToast.show("No opening balance items found for this supplier.");
            }

            var oFirst = aRawResults[0] || {};
            var sName = oFirst.Name1 || oFirst.NAME1 || "";
            oReconModel.setProperty("/mdSupplierName", sName);

            // Show "code - Name" in the Supplier field itself once the
            // name resolves, instead of leaving the bare numeric code â€"
            // onSearch strips the " - Name" suffix back off before using
            // this field's value as a filter, so this is display-only.
            if (sName) {
              that.byId("inputLifnr").setValue(sLifnr + " - " + sName);
            }

            var fBalance = 0;
            var aResults = aRawResults.map(function (o) {
              var fDmbtr = parseFloat(o.Dmbtr) || 0;
              var fSignedAmt = o.Shkzg === "H" ? -fDmbtr : fDmbtr;
              fBalance += fSignedAmt;
              return {
                Belnr: o.Belnr,
                Budat: o.Budat,
                // OpBalAsOnSet's field is spelled "Docty_dese" (typo baked
                // into the backend) â€" not "Docty_desc" like the other
                // entity sets. Confirmed against a live OpBalAsOnSet
                // response.
                Blart: o.Docty_dese || o.Blart,
                NetAmt: fSignedAmt,
                Augbl: o.Augdt,
                Bukrs: o.Bukrs,
                Lifnr: o.Lifnr,
                Name1: o.Name1,
                Sgtxt: o.Sgtxt,
                Rebzg: o.Rebzg,
                Waers: o.Waers,
                Bstat: o.Bstat,
                Bldat: o.Bldat,
                Umskz: o.Umskz,
                Shkzg: o.Shkzg,
              };
            });

            that._sortByBudatDesc(aResults);
            oReconModel.setProperty("/openItems", aResults);
            oReconModel.setProperty("/openItemsAll", aResults);
            oReconModel.setProperty("/openItemsTotal", fBalance);
            oReconModel.setProperty("/openingBalanceValue", fBalance);
            oReconModel.setProperty("/openItemsBusy", false);
            oReconModel.setProperty("/busy", false);
            oReconModel.setProperty("/mdSelectedMonthLabel", "");
            that._renderMonthlyBarChart(0);

            // Preload sidebar totals including transactionperiodSet immediately
            // after opening balance loads, so all Finance sidebar amounts are
            // ready before any clicks on Transactions/Advance/Debit Notes/Payments
            that._loadSidebarTotals(sBukrs, sLifnr, sKeyDate, sKeyDateTo);
          },
          error: function (oError) {
            // Same as PmtSelPrdSet: the backend raises a business exception
            // (HTTP 400, /IWBEP/CM_MGW_RT/022 "Data is not Found") instead of
            // returning 200 with an empty results array when this supplier
            // simply has no opening balance items for the date â€" treat that
            // as "no data" (handled by the IllustratedMessage in the view),
            // not a real error toast.
            var bNoDataFound = false;
            try {
              var oBody = JSON.parse(oError.responseText);
              bNoDataFound =
                !!oBody.error &&
                oBody.error.code === "/IWBEP/CM_MGW_RT/022";
            } catch (e) {
              bNoDataFound = false;
            }

            oReconModel.setProperty("/openItems", []);
            oReconModel.setProperty("/openItemsAll", []);
            oReconModel.setProperty("/openItemsTotal", 0);
            oReconModel.setProperty("/openingBalanceValue", 0);
            oReconModel.setProperty("/openItemsBusy", false);
            oReconModel.setProperty("/busy", false);
            that._renderMonthlyBarChart(0);

            if (!bNoDataFound) {
              oReconModel.setProperty("/mdSupplierName", "");
              MessageToast.show("Error loading opening balance.");
            }
          },
        });

        // Re-running the search (Go) should keep whichever Finance/Materials
        // row was already open â€" e.g. a user on Payments who only changes
        // From/To Date and presses Go stays on Payments with the new date
        // range, instead of silently being dropped back to Opening balance.
        // Opening balance's OWN data is already covered by the OpBalAsOnSet
        // read above; the "opening"/default case below still has to run,
        // though â€" it's what actually clears every OTHER panel's mdShowX
        // flag back to false (see that case's own comment).
        switch (this._sActiveMdPanel) {
          case "transactions":
            this.onTransactionsPress();
            break;
          case "advance":
            this.onAdvanceBalancePress();
            break;
          case "debitnotes":
            this.onDebitNotesPress();
            break;
          case "closingbalance":
            this.onClosingBalancePress();
            break;
          case "pendinginvoices":
            this.onPendingInvoicesPress();
            break;
          case "totalpo":
            this.onTotalPOPress();
            break;
          case "pendingpo":
            this.onPendingPOPress();
            break;
          case "lotsaccepted":
            this.onLotsAcceptedPress();
            break;
          case "lotsreceived":
            this.onLotsReceivedPress();
            break;
          case "rejectedqty":
            this.onRejectedQtyPress();
            break;
          case "acceptedqty":
            this.onAcceptedQtyPress();
            break;
          case "audqty":
            this.onAudQtyPress();
            break;
          case "shareofbusiness":
            // onShareOfBusinessPress always resets to the normal
            // Quantity/Value view (/totalShareBusinessActive false), so if
            // the Total Qty Breakdown table was showing, re-fire it too â€"
            // now with whatever From/To Date the user just changed via Go.
            var bWasTotalShareBusinessActive = this._oReconModel.getProperty(
              "/totalShareBusinessActive",
            );
            this.onShareOfBusinessPress();
            if (bWasTotalShareBusinessActive) {
              this._loadTotalShareBusinessBreakdown();
            }
            break;
          case "matreceipts":
            this.onMaterialReceiptsPress();
            break;
          case "vendorreturns":
            this.onVendorReturnsPress();
            break;
          case "payments":
            this.onPaymentsRowPress();
            break;
          case "generic":
            this._showMdPanel("mdShowGenericModule");
            oReconModel.setProperty(
              "/mdGenericModuleLabel",
              this._sActiveMdPanelLabel || "",
            );
            break;
          case "opening":
          default:
            // Opening Balance has no mdShowX flag of its own â€" it's just
            // whatever's left once every other panel's flag is false (see
            // OpenItemsPanel.fragment.xml's own visibility check) â€" so
            // landing here must actively clear every flag, not just skip
            // setting one. Without this, a session that had visited ANY
            // other panel (Closing Balance, Payments, ...) earlier keeps
            // that flag stuck true forever: this switch runs on every Go /
            // new-supplier navigation, and with no case matching "opening"
            // nothing ever reset it back to false, so the old panel kept
            // rendering underneath Opening Balance's own content on the
            // NEXT supplier too (e.g. clicking a different vendor row in
            // the Chart's table, which correctly resets _sActiveMdPanel to
            // "opening" beforehand â€" see onVendorItemPress â€" but that
            // alone was never enough without this case). _showMdPanel(null)
            // is idempotent, so this is also safe to run on a genuinely
            // fresh session where every flag was already false.
            this._showMdPanel(null);
        }
      },

      /**
       * Calls transactionperiodSet / VendBalAdvSet / DebitAmt1Set /
       * PmtSelPrdSet for the current Company Code/Supplier/date range and
       * stores each one's total into the same model properties their own
       * panels already read (/transactionsTotal, /advanceTotal,
       * /debitNotesTotal, /paymentsTotal) â€" used to populate the amount
       * shown next to each Finance (FI) sidebar row without requiring the
       * user to click into every section first.
       */
      _loadSidebarTotals: function (sBukrs, sLifnr, sKeyDate, sKeyDateTo) {
        var oModel = this.getOwnerComponent().getModel();
        var oReconModel = this._oReconModel;
        var sToDate = sKeyDateTo || sKeyDate;

        // Show busy indicator on sidebar while totals load
        oReconModel.setProperty("/sidebarBusy", true);

        // Track API call completion with a counter - increment for each request,
        // decrement on each success/error callback; when it reaches 0, all are done
        var iRequestCount = 0;
        var fnOnRequestComplete = function () {
          iRequestCount--;
          if (iRequestCount === 0) {
            oReconModel.setProperty("/sidebarBusy", false);
          }
        };

        // Every sidebar row EXCEPT Opening Balance means "as of today", not
        // "as of the financial-year start" â€" same rule _showMdPanel/
        // onOpeningBalancePress use for the panels themselves. Without this,
        // a fresh page load (To Date still sitting at its FY-start default
        // because Opening Balance is the initial panel) preloads every other
        // row's total for a single FY-start day instead of the FY-start-to-
        // today range, so Advance Balance/Transactions/Total PO/etc. all
        // show ~0 until the user manually opens a panel or presses Go again.
        if (sToDate === this._sFyStartDefault) {
          sToDate = this._toIsoDate(new Date());
        }
        var sLifnrPadded = String(sLifnr).padStart(10, "0");

        /** Dmbtr signed by Shkzg ("H" = credit, subtracted), same convention as every other panel here. */
        function sumSigned(aResults) {
          return (aResults || []).reduce(function (fSum, o) {
            var fDmbtr = parseFloat(o.Dmbtr) || 0;
            return fSum + (o.Shkzg === "H" ? -fDmbtr : fDmbtr);
          }, 0);
        }

        // Transactions
        iRequestCount++;
        var aTxnFilters = [
          new Filter("Bukrs", FilterOperator.EQ, sBukrs),
          new Filter("Lifnr", FilterOperator.EQ, sLifnr),
          new Filter("FromDate", FilterOperator.EQ, new Date(sKeyDate)),
        ];
        if (sToDate) {
          aTxnFilters.push(
            new Filter("ToDate", FilterOperator.EQ, new Date(sToDate)),
          );
        }
        oModel.read("/transactionperiodSet", {
          filters: aTxnFilters,
          success: function (oData) {
            oReconModel.setProperty(
              "/transactionsTotal",
              sumSigned(oData.results),
            );
            fnOnRequestComplete();
          },
          error: function () {
            oReconModel.setProperty("/transactionsTotal", 0);
            fnOnRequestComplete();
          },
        });

        // Advance balance â€" filter field must match onAdvanceBalancePress's
        // own VendBalAdvSet read ("Budat", not "BudatTo") so the sidebar
        // total agrees with the detail panel's total instead of silently
        // querying a different/nonexistent field.
        iRequestCount++;
        oModel.read("/VendBalAdvSet", {
          filters: [
            new Filter("Bukrs", FilterOperator.EQ, sBukrs),
            new Filter("Lifnr", FilterOperator.EQ, sLifnrPadded),
            new Filter("Budat", FilterOperator.EQ, new Date(sToDate)),
          ],
          success: function (oData) {
            oReconModel.setProperty("/advanceTotal", sumSigned(oData.results));
            fnOnRequestComplete();
          },
          error: function () {
            oReconModel.setProperty("/advanceTotal", 0);
            fnOnRequestComplete();
          },
        });

        // Debit notes â€" DebitAmt1Set's Dmbtr is already a plain positive
        // amount (no Shkzg sign to apply), same as onDebitNotesPress.
        iRequestCount++;
        oModel.read("/DebitAmt1Set", {
          filters: [
            new Filter("Bukrs", FilterOperator.EQ, sBukrs),
            new Filter("Lifnr", FilterOperator.EQ, sLifnrPadded),
            new Filter("BudatFrom", FilterOperator.EQ, new Date(sKeyDate)),
            new Filter("BudatTo", FilterOperator.EQ, new Date(sToDate)),
          ],
          success: function (oData) {
            var fTotal = (oData.results || []).reduce(function (fSum, o) {
              return fSum + (parseFloat(o.Dmbtr) || 0);
            }, 0);
            oReconModel.setProperty("/debitNotesTotal", fTotal);
            fnOnRequestComplete();
          },
          error: function () {
            oReconModel.setProperty("/debitNotesTotal", 0);
            fnOnRequestComplete();
          },
        });

        // Closing balance â€" same "value as on <To Date>" single-Budat
        // pattern as Advance balance/Pending invoices (not a BudatFrom/
        // BudatTo range like Debit notes/Total PO), same signed-Dmbtr
        // convention as onClosingBalancePress's own ClosingBalanceSet read.
        iRequestCount++;
        oModel.read("/ClosingBalanceSet", {
          filters: [
            new Filter("Bukrs", FilterOperator.EQ, sBukrs),
            new Filter("Lifnr", FilterOperator.EQ, sLifnrPadded),
            new Filter("Budat", FilterOperator.EQ, new Date(sToDate)),
          ],
          success: function (oData) {
            oReconModel.setProperty(
              "/closingBalanceTotal",
              sumSigned(oData.results),
            );
            fnOnRequestComplete();
          },
          error: function () {
            oReconModel.setProperty("/closingBalanceTotal", 0);
            fnOnRequestComplete();
          },
        });

        // Pending invoices â€" same "value as on <To Date>" pattern as
        // Advance balance.
        iRequestCount++;
        oModel.read("/PendInvValuesSet", {
          filters: [
            new Filter("Bukrs", FilterOperator.EQ, sBukrs),
            new Filter("Lifnr", FilterOperator.EQ, sLifnrPadded),
            new Filter("Budat", FilterOperator.EQ, new Date(sToDate)),
          ],
          success: function (oData) {
            oReconModel.setProperty(
              "/pendingInvoicesTotal",
              sumSigned(oData.results),
            );
            fnOnRequestComplete();
          },
          error: function () {
            oReconModel.setProperty("/pendingInvoicesTotal", 0);
            fnOnRequestComplete();
          },
        });

        // Total PO value â€" TotalPOSet returns one row per PO item with
        // Netwr already as a plain positive net value (no Shkzg sign to
        // apply), same BudatFrom/BudatTo range as Debit notes.
        iRequestCount++;
        oModel.read("/TotalPOSet", {
          filters: [
            new Filter("Bukrs", FilterOperator.EQ, sBukrs),
            new Filter("Lifnr", FilterOperator.EQ, sLifnrPadded),
            new Filter("BudatFrom", FilterOperator.EQ, new Date(sKeyDate)),
            new Filter("BudatTo", FilterOperator.EQ, new Date(sToDate)),
          ],
          success: function (oData) {
            var fTotal = (oData.results || []).reduce(function (fSum, o) {
              return fSum + (parseFloat(o.Netwr) || 0);
            }, 0);
            oReconModel.setProperty("/totalPOTotal", fTotal);
            fnOnRequestComplete();
          },
          error: function () {
            oReconModel.setProperty("/totalPOTotal", 0);
            fnOnRequestComplete();
          },
        });

        // Pending PO â€" pendingpoSet uses its own FromDate/ToDate filter
        // names (not BudatFrom/BudatTo like TotalPOSet/DebitAmt1Set), and
        // PendVal is already a plain positive pending value.
        oModel.read("/pendingpoSet", {
          filters: [
            new Filter("Bukrs", FilterOperator.EQ, sBukrs),
            new Filter("Lifnr", FilterOperator.EQ, sLifnrPadded),
            new Filter("FromDate", FilterOperator.EQ, new Date(sKeyDate)),
            new Filter("ToDate", FilterOperator.EQ, new Date(sToDate)),
          ],
          success: function (oData) {
            var aResults = oData.results || [];
            var fTotal = aResults.reduce(function (fSum, o) {
              return fSum + (parseFloat(o.PendVal) || 0);
            }, 0);
            var fQtyTotal = aResults.reduce(function (fSum, o) {
              return fSum + (parseFloat(o.PendQty) || 0);
            }, 0);
            oReconModel.setProperty("/pendingPOTotal", fTotal);
            // Preloaded here (not just inside onPendingPOPress) so the
            // Advance balance panel's "Total pending qty"/"Pending total"
            // tiles â€" which show Pending PO's own totals â€" are already
            // populated the moment the supplier is searched, same as
            // every other sidebar total.
            oReconModel.setProperty("/pendingPOQty", fQtyTotal);

            // Advance balance panel's "Total Qty Balance"/"Qty Balance
            // Amont" tile (AdvanceBalancePanel.fragment.xml) shows only
            // the Contract rows (Bstyp === "K", same split rule as
            // _onPendingPOCategorySelected/_renderPendingPOTypeBarChart) â€"
            // not every pendingpoSet row (which also includes plain POs,
            // Bstyp "F"), so it doesn't mix PO totals into what's meant to
            // be a contract-only figure.
            var aContractOnly = aResults.filter(function (o) {
              return o.Bstyp === "K";
            });
            oReconModel.setProperty(
              "/advanceContractTotal",
              aContractOnly.reduce(function (fSum, o) {
                return fSum + (parseFloat(o.PendVal) || 0);
              }, 0),
            );
            oReconModel.setProperty(
              "/advanceContractQty",
              aContractOnly.reduce(function (fSum, o) {
                return fSum + (parseFloat(o.PendQty) || 0);
              }, 0),
            );
          },
          error: function () {
            oReconModel.setProperty("/pendingPOTotal", 0);
            oReconModel.setProperty("/pendingPOQty", 0);
            oReconModel.setProperty("/advanceContractTotal", 0);
            oReconModel.setProperty("/advanceContractQty", 0);
          },
        });

        // Lots accepted â€" LotAcceptSet is keyed by Lifnr only (no Bukrs),
        // and uses its own Fromdate/Todate filter names (lowercase "date").
        oModel.read("/LotAcceptSet", {
          filters: [
            new Filter("Lifnr", FilterOperator.EQ, sLifnrPadded),
            new Filter("Fromdate", FilterOperator.EQ, new Date(sKeyDate)),
            new Filter("Todate", FilterOperator.EQ, new Date(sToDate)),
          ],
          success: function (oData) {
            var aResults = oData.results || [];
            var fTotal = aResults.reduce(function (fSum, o) {
              return fSum + (parseFloat(o.Losmenge) || 0);
            }, 0);
            oReconModel.setProperty("/lotsAcceptedTotal", fTotal);
            // Sidebar shows the lot count, not the summed quantity (same
            // "Total lots accepted" number as the panel's own stat tile).
            oReconModel.setProperty("/lotsAcceptedCount", aResults.length);
          },
          error: function () {
            oReconModel.setProperty("/lotsAcceptedTotal", 0);
            oReconModel.setProperty("/lotsAcceptedCount", 0);
          },
        });

        // Lots received â€" LotRecSet is keyed by Lifnr only (no Bukrs),
        // and uses FromDate/ToDate filter names (same casing as pendingpoSet).
        oModel.read("/LotRecSet", {
          filters: [
            new Filter("Lifnr", FilterOperator.EQ, sLifnrPadded),
            new Filter("FromDate", FilterOperator.EQ, new Date(sKeyDate)),
            new Filter("ToDate", FilterOperator.EQ, new Date(sToDate)),
          ],
          success: function (oData) {
            var aResults = oData.results || [];
            var fTotal = aResults.reduce(function (fSum, o) {
              return fSum + (parseFloat(o.Losmenge) || 0);
            }, 0);
            oReconModel.setProperty("/lotsReceivedTotal", fTotal);
            // Sidebar shows the lot count, not the summed quantity.
            oReconModel.setProperty("/lotsReceivedCount", aResults.length);
          },
          error: function () {
            oReconModel.setProperty("/lotsReceivedTotal", 0);
            oReconModel.setProperty("/lotsReceivedCount", 0);
          },
        });

        // Rejected qty â€" LotRejectSet is keyed by Lifnr only (no Bukrs),
        // and uses Fromdate/Todate filter names (lowercase "date", same
        // casing as LotAcceptSet).
        oModel.read("/LotRejectSet", {
          filters: [
            new Filter("Lifnr", FilterOperator.EQ, sLifnrPadded),
            new Filter("Fromdate", FilterOperator.EQ, new Date(sKeyDate)),
            new Filter("Todate", FilterOperator.EQ, new Date(sToDate)),
          ],
          success: function (oData) {
            var aResults = oData.results || [];
            var fTotal = aResults.reduce(function (fSum, o) {
              return fSum + (parseFloat(o.Losmenge) || 0);
            }, 0);
            oReconModel.setProperty("/rejectedQtyTotal", fTotal);
            // Sidebar shows the lot count, not the summed quantity (same
            // "Total lots rejected" number as the panel's own stat tile).
            oReconModel.setProperty("/rejectedQtyCount", aResults.length);
          },
          error: function () {
            oReconModel.setProperty("/rejectedQtyTotal", 0);
            oReconModel.setProperty("/rejectedQtyCount", 0);
          },
        });

        // AUD qty â€" LotAUDSet is keyed by Lifnr only (no Bukrs), same
        // Fromdate/Todate filter names as LotAcceptSet/LotRejectSet. Sidebar
        // shows only the lot count (no amount tile for this row yet).
        oModel.read("/LotAUDSet", {
          filters: [
            new Filter("Lifnr", FilterOperator.EQ, sLifnrPadded),
            new Filter("Fromdate", FilterOperator.EQ, new Date(sKeyDate)),
            new Filter("Todate", FilterOperator.EQ, new Date(sToDate)),
          ],
          success: function (oData) {
            oReconModel.setProperty(
              "/audQtyCount",
              (oData.results || []).length,
            );
          },
          error: function () {
            oReconModel.setProperty("/audQtyCount", 0);
          },
        });

        // Accepted qty â€" AcceptSet is keyed by Lifnr only (no Bukrs), same
        // Fromdate/Todate filter names as LotAcceptSet/LotRejectSet/LotAUDSet.
        oModel.read("/AcceptSet", {
          filters: [
            new Filter("Lifnr", FilterOperator.EQ, sLifnrPadded),
            new Filter("Fromdate", FilterOperator.EQ, new Date(sKeyDate)),
            new Filter("Todate", FilterOperator.EQ, new Date(sToDate)),
          ],
          success: function (oData) {
            var aResults = oData.results || [];
            var fTotal = aResults.reduce(function (fSum, o) {
              return fSum + (parseFloat(o.Losmenge) || 0);
            }, 0);
            oReconModel.setProperty("/acceptedQtyTotal", fTotal);
            // Sidebar shows the lot count, not the summed quantity (same
            // "Total lots accepted" number as the panel's own stat tile).
            oReconModel.setProperty("/acceptedQtyCount", aResults.length);
          },
          error: function () {
            oReconModel.setProperty("/acceptedQtyTotal", 0);
            oReconModel.setProperty("/acceptedQtyCount", 0);
          },
        });

        // Material receipts â€" MatReceiptSet is keyed by Bukrs+Lifnr (like
        // TotalPOSet), own Fromdate/Todate filter names.
        oModel.read("/MatReceiptSet", {
          filters: [
            new Filter("Bukrs", FilterOperator.EQ, sBukrs),
            new Filter("Lifnr", FilterOperator.EQ, sLifnrPadded),
            new Filter("Fromdate", FilterOperator.EQ, new Date(sKeyDate)),
            new Filter("Todate", FilterOperator.EQ, new Date(sToDate)),
          ],
          success: function (oData) {
            var fTotal = (oData.results || []).reduce(function (fSum, o) {
              return fSum + (parseFloat(o.Menge) || 0);
            }, 0);
            oReconModel.setProperty("/matReceiptsTotal", fTotal);
          },
          error: function () {
            oReconModel.setProperty("/matReceiptsTotal", 0);
          },
        });

        // Vendor returns â€" VendorReturnsSet, same Bukrs+Lifnr+Fromdate/
        // Todate filter shape as MatReceiptSet. Preloaded here (not just
        // inside onVendorReturnsPress) so the sidebar's "Vendor Returns"
        // row already shows its real item count the moment the supplier is
        // searched, same as every other sidebar row, instead of sitting at
        // "0 items" until that row is actually clicked once.
        oModel.read("/VendorReturnsSet", {
          filters: [
            new Filter("Bukrs", FilterOperator.EQ, sBukrs),
            new Filter("Lifnr", FilterOperator.EQ, sLifnrPadded),
            new Filter("Fromdate", FilterOperator.EQ, new Date(sKeyDate)),
            new Filter("Todate", FilterOperator.EQ, new Date(sToDate)),
          ],
          success: function (oData) {
            var aResults = oData.results || [];
            var fTotal = aResults.reduce(function (fSum, o) {
              return fSum + (parseFloat(o.Menge) || 0);
            }, 0);
            oReconModel.setProperty("/vendorReturnsTotal", fTotal);
            oReconModel.setProperty("/vendorReturnsCount", aResults.length);
          },
          error: function () {
            oReconModel.setProperty("/vendorReturnsTotal", 0);
            oReconModel.setProperty("/vendorReturnsCount", 0);
          },
        });

        // Share of Business â€" ShareOfBusinessSet is keyed by Lifnr only (no
        // Bukrs), same Fromdate/Todate filter names as LotAcceptSet/
        // LotAUDSet. Preloaded here (not just inside onShareOfBusinessPress)
        // so the left sidebar's "Share of Business" row shows its qty share
        // % the moment the supplier is searched, same as every other
        // module row's own summary figure, instead of only after that row
        // is clicked.
        oModel.read("/ShareOfBusinessSet", {
          filters: [
            new Filter("Lifnr", FilterOperator.EQ, sLifnrPadded),
            new Filter("Fromdate", FilterOperator.EQ, new Date(sKeyDate)),
            new Filter("Todate", FilterOperator.EQ, new Date(sToDate)),
          ],
          success: function (oData) {
            var o = (oData.results || [])[0] || {};
            oReconModel.setProperty(
              "/shareOfBusinessQtyPercent",
              o.SobMenge != null && String(o.SobMenge).trim() !== "" && !isNaN(parseFloat(o.SobMenge))
                ? String(o.SobMenge)
                : "",
            );
          },
          error: function () {
            oReconModel.setProperty("/shareOfBusinessQtyPercent", "");
          },
        });

        // Payments â€" PmtSelPrdSet raises a business exception (HTTP 400,
        // /IWBEP/CM_MGW_RT/022 "Data is not Found") instead of an empty
        // result when nothing matches the range; treat that the same as
        // onPaymentsRowPress does â€" zero, not an error.
        iRequestCount++;
        oModel.read("/PmtSelPrdSet", {
          filters: [
            new Filter("Bukrs", FilterOperator.EQ, sBukrs),
            new Filter("Lifnr", FilterOperator.EQ, sLifnrPadded),
            new Filter(
              "BudatFrom",
              FilterOperator.EQ,
              this._toUtcMidnight(sKeyDate),
            ),
            new Filter(
              "BudatTo",
              FilterOperator.EQ,
              this._toUtcMidnight(sToDate),
            ),
          ],
          success: function (oData) {
            oReconModel.setProperty("/paymentsTotal", sumSigned(oData.results));
            fnOnRequestComplete();
          },
          error: function () {
            oReconModel.setProperty("/paymentsTotal", 0);
            fnOnRequestComplete();
          },
        });
      },

      /** Sorts open items newest-first by posting date (Budat), in place. */
      _sortByBudatDesc: function (aItems) {
        aItems.sort(function (a, b) {
          return new Date(b.Budat).getTime() - new Date(a.Budat).getTime();
        });
      },

      /** Sum of NetAmt across a raw OpenItemsSet result array. */
      _sumNetAmt: function (aItems) {
        return (aItems || []).reduce(function (fSum, o) {
          return fSum + (parseFloat(o.NetAmt) || 0);
        }, 0);
      },

      _buildDonutData: function (aResults) {
        var that = this;

        var aCategories = aResults.map(function (o) {
          var fNet = (parseFloat(o.InvAmt) || 0) + (parseFloat(o.AdvAmt) || 0);
          return {
            category: that.formatCategory(o.Txt50),
            rawTxt50: o.Txt50,
            akont: o.Akont,
            netAmt: fNet,
            absNetAmt: Math.abs(fNet),
          };
        });

        var fTotalNet = aCategories.reduce(function (s, o) {
          return s + o.netAmt;
        }, 0);
        var fTotalAbs =
          aCategories.reduce(function (s, o) {
            return s + Math.abs(o.netAmt);
          }, 0) || 1;

        var aDonut = aCategories.map(function (o, i) {
          var fPercent = fTotalNet !== 0 ? (o.netAmt / fTotalNet) * 100 : 0;
          return {
            category: o.category,
            rawTxt50: o.rawTxt50,
            akont: o.akont,
            netAmt: o.netAmt,
            absNetAmt: o.absNetAmt,
            share: Math.abs(o.netAmt) / fTotalAbs,
            percentLabel: fPercent.toFixed(1) + "%",
            colorHex: COLOR_HEX[i % COLOR_HEX.length],
          };
        });

        var oTotals = aResults.reduce(
          function (o, oRow) {
            o.invAmt += parseFloat(oRow.InvAmt) || 0;
            o.advAmt += parseFloat(oRow.AdvAmt) || 0;
            o.netAmt += parseFloat(oRow.NetAmt) || 0;
            return o;
          },
          { invAmt: 0, advAmt: 0, netAmt: 0 },
        );

        this._oReconModel.setData({
          items: aResults,
          donut: aDonut,
          count: aResults.length,
          totals: oTotals,
          busy: false,
          vendorsBusy: false,
          selectedCategory: "",
          openItems: [],
          openItemsBusy: false,
          selectedVendor: "",
          kpiTiles: {
            re: { count: 0, invAmt: 0, netAmt: 0 },
            other: { count: 0, invAmt: 0, netAmt: 0 },
          },
          masterDetailMode: false,
        });

        if (aResults.length > 0) {
          this._showTab("chart");
        }

        // Give UI5 a tick to mount the now-visible core:HTML divs before drawing.
        // Without this, the "visible" binding on the card and the SVG draw
        // race each other and the chart renders into a DOM that isn't there yet.
        var that2 = this;
        setTimeout(function () {
          that2._renderDonutSvg(0);
        }, 0);
      },

      /**
       * Called when a category is clicked, either from a "Top Categories" bar
       * row or a donut slice. Loads the vendor-level breakdown for that
       * category's reconciliation account (AKONT) from VENDERSet, using the
       * company code and key date from the last search, then switches to
       * the Vendors tab and binds the result into the vendors table.
       */
      _onCategorySelected: function (sAkont, sCategoryLabel) {
        var oModel = this.getOwnerComponent().getModel();
        var oReconModel = this._oReconModel;
        var that = this;

        if (!sAkont || !this._sBukrs || !this._sKeyDate) {
          return;
        }

        var sAkontPadded = String(sAkont).padStart(10, "0");
        this._sSelectedAkont = sAkontPadded;

        oReconModel.setProperty("/vendorsBusy", true);
        oReconModel.setProperty("/selectedCategory", sCategoryLabel);
        oReconModel.setProperty("/selectedVendor", "");
        oReconModel.setProperty("/openItems", []);
        this._showTab("vendors");

        var aFilters = [
          new Filter("BUKRS", FilterOperator.EQ, this._sBukrs),
          this._getBudatFilter("BUDAT"),
          new Filter("AKONT", FilterOperator.EQ, sAkontPadded),
        ];

        oModel.read("/VENDERSet", {
          filters: aFilters,
          success: function (oData) {
            var aResults = (oData.results || []).map(function (o) {
              return {
                Lifnr: o.LIFNR,
                Name1: o.NAME1,
                Txt50: sCategoryLabel,
                InvAmt: o.INV_AMT,
                AdvAmt: o.ADV_AMT,
                NetAmt: o.NET_AMT,
                TrgMenge: o.TRG_MENGE,
                TrgNetpr: o.TRG_NETPR,
              };
            });
            if (aResults.length === 0) {
              MessageToast.show("No vendor items found for this category.");
            }
            oReconModel.setProperty("/items", aResults);
            oReconModel.setProperty("/vendorsBusy", false);
          },
          error: function () {
            oReconModel.setProperty("/vendorsBusy", false);
            MessageToast.show("Error loading vendor data.");
          },
        });
      },

      /**
       * Fired when a row in the Vendors table is pressed. Switches straight
       * into the master-detail Finance/Materials/Quality summary for that
       * vendor (same view as entering a Supplier NO directly in the filter
       * bar), using the company code / date range from the last search.
       */
      onVendorItemPress: function (oEvent) {
        // table:Table's cellClick gives the row context directly as a
        // parameter; fall back to the source's own binding context for any
        // other control that might still fire this the sap.m.Table way.
        var oCtx =
          oEvent.getParameter("rowBindingContext") ||
          oEvent.getSource().getBindingContext("recon");
        if (!oCtx) return;
        var sLifnr = oCtx.getProperty("Lifnr");
        if (!sLifnr || !this._sBukrs || !this._sKeyDate) return;

        this.byId("inputLifnr").setValue(sLifnr);
        this._sActiveMdPanel = "opening"; this._persistUiState();
        this._sActiveMdPanelLabel = "";

        // Same navigation onSearch uses for a Supplier + Go press â€" the
        // master-detail summary is its own routed page (Detail.view.xml /
        // Routedetail), not a mode flag on this view, so a vendor-row click
        // has to navigate there too instead of loading data into Main's own
        // (non-existent) master-detail controls.
        this.getOwnerComponent()
          .getRouter()
          .navTo("Routedetail", {
            bukrs: encodeURIComponent(this._sBukrs),
            lifnr: encodeURIComponent(sLifnr),
            fromdate: encodeURIComponent(this._sKeyDate || ""),
            todate: encodeURIComponent(this._sKeyDateTo || this._sKeyDate || ""),
          });
      },

      _loadOpenItems: function (sLifnr) {
        var oModel = this.getOwnerComponent().getModel();
        var oReconModel = this._oReconModel;

        if (
          !sLifnr ||
          !this._sBukrs ||
          !this._sKeyDate ||
          !this._sSelectedAkont
        ) {
          return;
        }

        oReconModel.setProperty("/openItemsBusy", true);
        oReconModel.setProperty("/openItems", []);
        oReconModel.setProperty("/kpiTiles", {
          re: { count: 0, invAmt: 0, netAmt: 0 },
          other: { count: 0, invAmt: 0, netAmt: 0 },
        });
        oReconModel.setProperty("/selectedVendor", sLifnr);
        this._showTab("kpi");

        var aFilters = [
          new Filter("Bukrs", FilterOperator.EQ, this._sBukrs),
          this._getBudatFilter("Budat"),
          new Filter("Akont", FilterOperator.EQ, this._sSelectedAkont),
          new Filter("Lifnr", FilterOperator.EQ, sLifnr),
        ];

        var that = this;
        oModel.read("/OpenItemsSet", {
          filters: aFilters,
          success: function (oData) {
            var aResults = oData.results || [];
            if (aResults.length === 0) {
              MessageToast.show("No open items found for this vendor.");
            }
            oReconModel.setProperty("/openItems", aResults);
            oReconModel.setProperty("/openItemsBusy", false);
            oReconModel.setProperty(
              "/kpiTiles",
              that._buildKpiTileTotals(aResults),
            );
          },
          error: function () {
            oReconModel.setProperty("/openItemsBusy", false);
            MessageToast.show("Error loading open items.");
          },
        });
      },

      /**
       * Summarizes the loaded open items into "RE Documents" / "Non-RE
       * Documents" buckets, totalling Invoice Amt and Net Amt for each â€" the
       * data behind the two GenericTiles in the Open Items tab.
       */
      _buildKpiTileTotals: function (aOpenItems) {
        var oRe = { count: 0, invAmt: 0, netAmt: 0 };
        var oOther = { count: 0, invAmt: 0, netAmt: 0 };

        aOpenItems.forEach(function (o) {
          var oBucket = o.Blart === "RE" ? oRe : oOther;
          oBucket.count += 1;
          oBucket.invAmt += parseFloat(o.InvAmt) || 0;
          oBucket.netAmt += parseFloat(o.NetAmt) || 0;
        });

        return { re: oRe, other: oOther };
      },

      /**
       * Opens the Open Items detail dialog (fragment) filtered to the
       * document type of the pressed GenericTile ("RE" or "OTHER"), read
       * off its "docType" customData.
       */
      onOpenItemsTilePress: function (oEvent) {
        var that = this;
        var sDocType = oEvent.getSource().data("docType");
        var aOpenItems = this._oReconModel.getProperty("/openItems") || [];
        var aFiltered = aOpenItems.filter(function (o) {
          return sDocType === "RE" ? o.Blart === "RE" : o.Blart !== "RE";
        });

        // Base (doc-type-only) set the search field filters on top of, and
        // the sort state reset for a fresh open â€" otherwise a stale sort
        // from the last time this dialog was opened would silently keep
        // re-applying to a different tile's data.
        this._aOpenItemsDetailBase = aFiltered;
        this._sOpenItemsDetailSortField = null;
        this._bOpenItemsDetailSortDesc = false;

        this._oReconModel.setProperty("/filteredOpenItems", aFiltered);
        this._oReconModel.setProperty(
          "/filteredOpenItemsTitle",
          sDocType === "RE" ? "RE Documents" : "Non-RE Documents",
        );

        if (this._oOpenItemsDetailSearchField) {
          this._oOpenItemsDetailSearchField.setValue("");
        }

        if (!this._oOpenItemsDetailDialog) {
          Fragment.load({
            id: this.getView().getId(),
            name: "supplieropenitems.view.fragment.Openitemsdetail",
            controller: this,
          }).then(function (oDialog) {
            that._oOpenItemsDetailDialog = oDialog;
            that._oOpenItemsDetailSearchField = Fragment.byId(
              that.getView().getId(),
              "openItemsDetailSearchField",
            );
            that.getView().addDependent(oDialog);
            oDialog.open();
          });
        } else {
          this._oOpenItemsDetailDialog.open();
        }
      },

      onCloseOpenItemsDetail: function () {
        if (this._oOpenItemsDetailDialog) {
          this._oOpenItemsDetailDialog.close();
        }
      },

      /**
       * Filters the Open Items detail dialog's table on top of whichever
       * doc-type set (RE / Non-RE) is currently open â€" matches the search
       * text against Document/Type/Vendor/PO Number, case-insensitive,
       * substring match (same "good enough" matching every other filter in
       * this file uses).
       */
      onOpenItemsDetailSearch: function (oEvent) {
        var sQuery = (oEvent.getParameter("newValue") || "").trim().toLowerCase();
        var aBase = this._aOpenItemsDetailBase || [];

        var aFiltered = !sQuery
          ? aBase
          : aBase.filter(function (o) {
              return [o.Belnr, o.Blart, o.Lifnr, o.Ebeln]
                .some(function (v) {
                  return String(v || "").toLowerCase().indexOf(sQuery) !== -1;
                });
            });

        // Re-apply whatever sort was active before this keystroke, so
        // searching doesn't silently drop the user back to insertion order.
        if (this._sOpenItemsDetailSortField) {
          this._sortOpenItemsDetailBy(
            aFiltered,
            this._sOpenItemsDetailSortField,
            this._bOpenItemsDetailSortDesc,
          );
        }

        this._oReconModel.setProperty("/filteredOpenItems", aFiltered);
      },

      /** Numeric-aware compare used by the Open Items detail dialog's per-column sort buttons. */
      _sortOpenItemsDetailBy: function (aItems, sField, bDesc) {
        var aNumericFields = ["InvAmt", "AdvAmt", "NetAmt"];
        var bNumeric = aNumericFields.indexOf(sField) !== -1;

        aItems.sort(function (a, b) {
          var x = a[sField];
          var y = b[sField];
          var iCmp;
          if (bNumeric) {
            iCmp = (parseFloat(x) || 0) - (parseFloat(y) || 0);
          } else if (sField === "Budat" || sField === "Bldat") {
            iCmp = new Date(x).getTime() - new Date(y).getTime();
          } else {
            iCmp = String(x || "").localeCompare(String(y || ""));
          }
          return bDesc ? -iCmp : iCmp;
        });
      },

      /**
       * Fired from the small sort icon next to each column header in the
       * Open Items detail dialog. Clicking the same field again flips
       * ascending/descending; clicking a different field starts it fresh at
       * ascending â€" same toggle convention as any column-header sort.
       */
      onOpenItemsDetailSort: function (oEvent) {
        var sField = oEvent.getSource().data("field");
        if (!sField) return;

        if (this._sOpenItemsDetailSortField === sField) {
          this._bOpenItemsDetailSortDesc = !this._bOpenItemsDetailSortDesc;
        } else {
          this._sOpenItemsDetailSortField = sField;
          this._bOpenItemsDetailSortDesc = false;
        }

        var aItems = (this._oReconModel.getProperty("/filteredOpenItems") || []).slice();
        this._sortOpenItemsDetailBy(
          aItems,
          this._sOpenItemsDetailSortField,
          this._bOpenItemsDetailSortDesc,
        );
        this._oReconModel.setProperty("/filteredOpenItems", aItems);
      },

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // Column Settings / Select Layout â€" shared across EVERY master-detail
      // line-items grid (Opening balance/masterDetailTable, Transactions,
      // Advance balance, Debit notes, Payments): all five tables render the
      // same 5-column schema (Document/Date/Type/Amount/Status â€" oiCol1..5,
      // via bindings recon>Belnr/Budat/Blart/NetAmt/Augbl that already exist
      // on every one of those row shapes), so one Column Settings dialog and
      // one Select Layout dialog can drive all five at once. Applying or
      // saving a layout broadcasts the same column order/visibility to every
      // table in OI_TABLE_IDS in one go â€" that's the "same layout for all"
      // behavior. (Advance balance has no clearing document and Debit notes
      // has neither a posting date nor a clearing document, so Status/Date
      // just render blank/"Open" defaults there if included â€" still a
      // consistent column set, just not always meaningful data.)
      //
      // Same picker â†' apply â†' offer-to-save flow as any backend-backed
      // layout feature; this persists to ZSUPPLIER_DLT_SRV's LayoutSet
      // entity set (see the "Select Layout" section further down).
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

      OI_TABLE_IDS: [
        "masterDetailTable",
        "transactionsTable",
        "advanceTable",
        "debitNotesTable",
        "paymentsTable",
        "pendingInvoicesTable",
        "closingBalanceTable",
      ],

      // Every other master-detail table (MATERIALS (MM) / QUALITY (QM)
      // groups) has its OWN column schema â€" unlike the six FI tables above,
      // which all render the identical 15-field OpenItemsSet shape. Column
      // Settings/Select Layout used to be wired to the same shared FI
      // column list (Document/Date/Type/Amount/Status/...) regardless of
      // which table's button was pressed, so opening it from e.g. AUD qty
      // or Total PO showed completely unrelated field names. TABLE_CATEGORY
      // + MM_QM_COLUMN_DEFS give every non-FI table its own real column
      // list, and tag which of FI/MM/QM it belongs to so saved layouts
      // (LayoutSet's Category field) never cross-apply between sections.
      TABLE_CATEGORY: {
        masterDetailTable: "FI",
        transactionsTable: "FI",
        advanceTable: "FI",
        debitNotesTable: "FI",
        paymentsTable: "FI",
        pendingInvoicesTable: "FI",
        totalPOTable: "MM",
        pendingPOTable: "MM",
        matReceiptsTable: "MM",
        vendorReturnsTable: "MM",
        lotsReceivedTable: "QM",
        lotsAcceptedTable: "QM",
        rejectedQtyTable: "QM",
        acceptedQtyTable: "QM",
        audQtyTable: "QM",
      },

      /** TABLE_CATEGORY lookup, defaulting to "FI" for anything unlisted. */
      _getTableCategory: function (sTableId) {
        return this.TABLE_CATEGORY[sTableId] || "FI";
      },


      MM_QM_COLUMN_DEFS: {
       
        totalPOTable: [
          { id: "col1", label: "PO Number", field: "Ebeln", width: "8rem", cell: function () { return new sap.m.Text({ text: "{recon>Ebeln}" }); } },
          { id: "col7", label: "Date", field: "Bedat", width: "7rem", cell: function (that) { return new sap.m.Text({ text: { path: "recon>Bedat", formatter: that.formatOpenItemDate.bind(that) } }); } },
          { id: "col6", label: "Quantity", field: "Menge", width: "8rem", hAlign: "End", cell: function () { return new sap.m.Text({ text: "{= ${recon>Menge} + ' ' + ${recon>Meins} }" }); } },
          { id: "col9", label: "Unit Price", field: "Netpr", width: "8rem", hAlign: "End", cell: function (that) { return new sap.m.Text({ text: { path: "recon>Netpr", formatter: that.formatAmount.bind(that) } }); } },
          { id: "col21", label: "Net Value", field: "Netwr", width: "8rem", hAlign: "End", cell: function (that) { return new sap.m.Text({ text: { path: "recon>Netwr", formatter: that.formatAmount.bind(that) } }); } },
          { id: "col2", label: "PO Item", field: "Ebelp", width: "6rem", cell: function () { return new sap.m.Text({ text: "{recon>Ebelp}" }); } },
          { id: "col5", label: "Material Number", field: "Matnr", width: "8rem", cell: function () { return new sap.m.Text({ text: "{recon>Matnr}" }); } },
          { id: "col10", label: "PO Type", field: "Bsart", width: "6rem", cell: function () { return new sap.m.Text({ text: "{recon>Bsart}" }); } },
          { id: "col22", label: "Document Category", field: "Bstyp", width: "7rem", cell: function () { return new sap.m.Text({ text: "{recon>Bstyp}" }); } },
          { id: "col3", label: "Company Code", field: "Bukrs", width: "6rem", cell: function () { return new sap.m.Text({ text: "{recon>Bukrs}" }); } },
          { id: "col4", label: "Supplier", field: "Lifnr", width: "7rem", cell: function () { return new sap.m.Text({ text: "{recon>Lifnr}" }); } },
          { id: "col11", label: "Supplier Name", field: "Name1", width: "10rem", cell: function () { return new sap.m.Text({ text: "{recon>Name1}", wrapping: false }); } },
          { id: "col12", label: "Price Unit", field: "Peinh", width: "6rem", hAlign: "End", cell: function () { return new sap.m.Text({ text: "{recon>Peinh}" }); } },
          { id: "col13", label: "Currency", field: "Waers", width: "6rem", cell: function () { return new sap.m.Text({ text: "{recon>Waers}" }); } },
          { id: "col28", label: "Material Description", field: "Maktx", width: "10rem", cell: function () { return new sap.m.Text({ text: "{recon>Maktx}", wrapping: false }); } },
        ],
        // Every field pendingpoSet's response actually returns, per the
        // aItems map in onPendingPOPress (Ebeln, Ebelp, Bukrs, Lifnr, Name1,
        // Bedat, Bsart, Matnr, Txz01, Maktx, Menge, EketMenge, Wemng,
        // PendQty, Meins, Netpr, Peinh, PendVal, Waers) gets its own
        // selectable column here, not just the 6 shown by default.
        pendingPOTable
        :[
          { id: "col1", label: "PO Number", field: "Ebeln", width: "8rem", cell: function () { return new sap.m.Text({ text: "{recon>Ebeln}" }); } },
          { id: "col7", label: "Date", field: "Bedat", width: "7rem", cell: function (that) { return new sap.m.Text({ text: { path: "recon>Bedat", formatter: that.formatOpenItemDate.bind(that) } }); } },
          
          { id: "col6", label: "Quantity", field: "Menge", width: "8rem", hAlign: "End", cell: function () { return new sap.m.Text({ text: "{= ${recon>Menge} + ' ' + ${recon>Meins} }" }); } },
          { id: "col9", label: "Unit Price", field: "Netpr", width: "8rem", hAlign: "End", cell: function (that) { return new sap.m.Text({ text: { path: "recon>Netpr", formatter: that.formatAmount.bind(that) } }); } },
          { id: "col21", label: "Net Value", field: "Netwr", width: "8rem", hAlign: "End", cell: function (that) { return new sap.m.Text({ text: { path: "recon>Netwr", formatter: that.formatAmount.bind(that) } }); } },
          { id: "col2", label: "PO Item", field: "Ebelp", width: "6rem", cell: function () { return new sap.m.Text({ text: "{recon>Ebelp}" }); } },
          { id: "col5", label: "Material Number", field: "Matnr", width: "8rem", cell: function () { return new sap.m.Text({ text: "{recon>Matnr}" }); } },
          { id: "col10", label: "PO Type", field: "Bsart", width: "6rem", cell: function () { return new sap.m.Text({ text: "{recon>Bsart}" }); } },
          { id: "col22", label: "Document Category", field: "Bstyp", width: "7rem", cell: function () { return new sap.m.Text({ text: "{recon>Bstyp}" }); } },
          { id: "col3", label: "Company Code", field: "Bukrs", width: "6rem", cell: function () { return new sap.m.Text({ text: "{recon>Bukrs}" }); } },
          { id: "col4", label: "Supplier", field: "Lifnr", width: "7rem", cell: function () { return new sap.m.Text({ text: "{recon>Lifnr}" }); } },
          { id: "col11", label: "Supplier Name", field: "Name1", width: "10rem", cell: function () { return new sap.m.Text({ text: "{recon>Name1}", wrapping: false }); } },
          { id: "col12", label: "Price Unit", field: "Peinh", width: "6rem", hAlign: "End", cell: function () { return new sap.m.Text({ text: "{recon>Peinh}" }); } },
          { id: "col13", label: "Currency", field: "Waers", width: "6rem", cell: function () { return new sap.m.Text({ text: "{recon>Waers}" }); } },
          { id: "col28", label: "Material Description", field: "Maktx", width: "10rem", cell: function () { return new sap.m.Text({ text: "{recon>Maktx}", wrapping: false }); } },
        ],
        // Every field MatReceiptSet's response actually returns, per the
        // aItems map in onMaterialReceiptsPress (Mblnr, Zeile, Werks, Bukrs,
        // Gjahr, Lifnr, Ebeln, Ebelp, Bwart, Matnr, Maktx, Lgort, Menge,
        // Meins, Budat_mkpf, Dmbtr) gets its own selectable column here, not
        // just the 7 shown by default.
       matReceiptsTable: [

    {
        id: "col1",
        label: "PO Number",
        field: "Ebeln",
        width: "8rem",
        cell: function () {
            return new sap.m.Text({
                text: "{recon>Ebeln}"
            });
        }
    },

    {
        id: "col7",
        label: "Date",
        field: "Budat_mkpf",
        width: "7rem",
        cell: function (that) {
            return new sap.m.Text({
                text: {
                    path: "recon>Budat_mkpf",
                    formatter: that.formatOpenItemDate.bind(that)
                }
            });
        }
    },

    {
        id: "col6",
        label: "Quantity",
        field: "Menge",
        width: "8rem",
        hAlign: "End",
        cell: function () {
            return new sap.m.Text({
                text: "{= ${recon>Menge} + ' ' + ${recon>Meins} }"
            });
        }
    },

    {
        id: "col21",
        label: "Net Value",
        field: "Dmbtr",
        width: "8rem",
        hAlign: "End",
        cell: function (that) {
            return new sap.m.Text({
                text: {
                    path: "recon>Dmbtr",
                    formatter: that.formatAmount.bind(that)
                }
            });
        }
    },

    {
        id: "col2",
        label: "PO Item",
        field: "Ebelp",
        width: "6rem",
        cell: function () {
            return new sap.m.Text({
                text: "{recon>Ebelp}"
            });
        }
    },

    {
        id: "col5",
        label: "Material Number",
        field: "Matnr",
        width: "8rem",
        cell: function () {
            return new sap.m.Text({
                text: "{recon>Matnr}"
            });
        }
    },

    {
        id: "col3",
        label: "Company Code",
        field: "Bukrs",
        width: "6rem",
        cell: function () {
            return new sap.m.Text({
                text: "{recon>Bukrs}"
            });
        }
    },

    {
        id: "col4",
        label: "Supplier",
        field: "Lifnr",
        width: "7rem",
        cell: function () {
            return new sap.m.Text({
                text: "{recon>Lifnr}"
            });
        }
    },

    {
        id: "col28",
        label: "Material Description",
        field: "Maktx",
        width: "10rem",
        cell: function () {
            return new sap.m.Text({
                text: "{recon>Maktx}",
                wrapping: false
            });
        }
    }

],
        // Every field VendorReturnsSet's response actually returns, per the
        // aItems map in onVendorReturnsPress (Mblnr, Zeile, Werks, Bukrs,
        // Gjahr, Lifnr, Ebeln, Ebelp, Bwart, Matnr, Maktx, Lgort, Menge,
        // Meins, BudatMkpf) gets its own selectable column here, not just
        // the 7 shown by default.
       vendorReturnsTable: [

    {
        id: "col1",
        label: "PO Number",
        field: "Ebeln",
        width: "8rem",
        cell: function () {
            return new sap.m.Text({
                text: "{recon>Ebeln}"
            });
        }
    },

    {
        id: "col7",
        label: "Date",
        field: "BudatMkpf",
        width: "7rem",
        cell: function (that) {
            return new sap.m.Text({
                text: {
                    path: "recon>BudatMkpf",
                    formatter: that.formatOpenItemDate.bind(that)
                }
            });
        }
    },

    {
        id: "col6",
        label: "Quantity",
        field: "Menge",
        width: "8rem",
        hAlign: "End",
        cell: function () {
            return new sap.m.Text({
                text: "{= ${recon>Menge} + ' ' + ${recon>Meins} }"
            });
        }
    },

    {
        id: "col2",
        label: "PO Item",
        field: "Ebelp",
        width: "6rem",
        cell: function () {
            return new sap.m.Text({
                text: "{recon>Ebelp}"
            });
        }
    },

    {
        id: "col5",
        label: "Material Number",
        field: "Matnr",
        width: "8rem",
        cell: function () {
            return new sap.m.Text({
                text: "{recon>Matnr}"
            });
        }
    },

    {
        id: "col3",
        label: "Company Code",
        field: "Bukrs",
        width: "6rem",
        cell: function () {
            return new sap.m.Text({
                text: "{recon>Bukrs}"
            });
        }
    },

    {
        id: "col4",
        label: "Supplier",
        field: "Lifnr",
        width: "7rem",
        cell: function () {
            return new sap.m.Text({
                text: "{recon>Lifnr}"
            });
        }
    },

    {
        id: "col28",
        label: "Material Description",
        field: "Maktx",
        width: "10rem",
        cell: function () {
            return new sap.m.Text({
                text: "{recon>Maktx}",
                wrapping: false
            });
        }
    }

],
      
        lotsReceivedTable: [
          { id: "col1", label: "Lot Number", field: "Prueflos", width: "9rem", cell: function (that) { return new Link({ text: "{recon>Prueflos}", press: that.onLotsReceivedLotNumberPress.bind(that) }); } },
          { id: "col2", label: "Plant", field: "Werks", width: "6rem", cell: function () { return new sap.m.Text({ text: "{recon>Werks}" }); } },
          { id: "col3", label: "Date", field: "Enstehdat", width: "7rem", cell: function (that) { return new sap.m.Text({ text: { path: "recon>Enstehdat", formatter: that.formatOpenItemDate.bind(that) } }); } },
          { id: "col4", label: "Material", field: "Matnr", width: "8rem", cell: function () { return new sap.m.Text({ text: "{recon>Matnr}", wrapping: false }); } },
          { id: "col5", label: "Material Description", field: "Maktx", width: "10rem", cell: function () { return new sap.m.Text({ text: "{recon>Maktx}", wrapping: false }); } },
          { id: "col6", label: "Batch", field: "Charg", width: "7rem", cell: function () { return new sap.m.Text({ text: "{recon>Charg}" }); } },
          { id: "col7", label: "Code", field: "Vcode", width: "6rem", cell: function () { return new sap.m.Text({ text: "{recon>Vcode}" }); } },
          { id: "col8", label: "Lot Quantity", field: "Losmenge", width: "8rem", hAlign: "End", cell: function (that) { return new sap.m.Text({ text: { path: "recon>Losmenge", formatter: that.formatAmount.bind(that) } }); } },
          { id: "col9", label: "Inspection Type", field: "Art", width: "7rem", cell: function () { return new sap.m.Text({ text: "{recon>Art}" }); } },
          { id: "col12", label: "Object Number", field: "Objnr", width: "9rem", cell: function () { return new sap.m.Text({ text: "{recon>Objnr}" }); } },
          { id: "col13", label: "Object Type", field: "Obtyp", width: "6rem", cell: function () { return new sap.m.Text({ text: "{recon>Obtyp}" }); } },
          { id: "col14", label: "Status", field: "Stat01", width: "6rem", cell: function () { return new sap.m.Text({ text: "{recon>Stat01}" }); } },
          { id: "col10", label: "Supplier", field: "Lifnr", width: "7rem", cell: function () { return new sap.m.Text({ text: "{recon>Lifnr}" }); } },
          { id: "col15", label: "Characteristic Type", field: "Kzart", width: "7rem", cell: function () { return new sap.m.Text({ text: "{recon>Kzart}" }); } },
          { id: "col16", label: "Order Number", field: "Aufnr", width: "8rem", cell: function () { return new sap.m.Text({ text: "{recon>Aufnr}" }); } },
          { id: "col17", label: "Material Doc.", field: "Mblnr", width: "8rem", cell: function () { return new sap.m.Text({ text: "{recon>Mblnr}" }); } },
          { id: "col11", label: "Acceptance %", field: "Qkennzahl", width: "7rem", hAlign: "End", cell: function () { return new sap.m.Text({ text: "{recon>Qkennzahl}" }); } },
        ],
        // Every field LotAcceptSet's response actually returns, per the
        // aItems map in onLotsAcceptedPress (Prueflos, Werks, Art, Matnr,
        // Maktx, Lifnr, Vcode, Qkennzahl, Charg, Losmenge, Enstehdat) gets
        // its own selectable column here, not just the 7 shown by default â€"
        // see the shared col1..col17 numbering comment above lotsReceivedTable.
        lotsAcceptedTable: [
          { id: "col1", label: "Lot Number", field: "Prueflos", width: "9rem", cell: function (that) { return new sap.m.Link({ text: "{recon>Prueflos}", press: that.onLotsReceivedLotNumberPress.bind(that) }); } },
          { id: "col2", label: "Plant", field: "Werks", width: "6rem", cell: function () { return new sap.m.Text({ text: "{recon>Werks}" }); } },
          { id: "col3", label: "Date", field: "Enstehdat", width: "7rem", cell: function (that) { return new sap.m.Text({ text: { path: "recon>Enstehdat", formatter: that.formatOpenItemDate.bind(that) } }); } },
          { id: "col4", label: "Material", field: "Matnr", width: "8rem", cell: function () { return new sap.m.Text({ text: "{recon>Matnr}", wrapping: false }); } },
          { id: "col5", label: "Material Description", field: "Maktx", width: "10rem", cell: function () { return new sap.m.Text({ text: "{recon>Maktx}", wrapping: false }); } },
          { id: "col6", label: "Batch", field: "Charg", width: "7rem", cell: function () { return new sap.m.Text({ text: "{recon>Charg}" }); } },
          { id: "col11", label: "Acceptance %", field: "Qkennzahl", width: "7rem", hAlign: "End", cell: function () { return new sap.m.Text({ text: "{recon>Qkennzahl}" }); } },
          { id: "col8", label: "Lot Quantity", field: "Losmenge", width: "8rem", hAlign: "End", cell: function (that) { return new sap.m.Text({ text: { path: "recon>Losmenge", formatter: that.formatAmount.bind(that) } }); } },
          { id: "col9", label: "Inspection Type", field: "Art", width: "7rem", cell: function () { return new sap.m.Text({ text: "{recon>Art}" }); } },
          { id: "col10", label: "Supplier", field: "Lifnr", width: "7rem", cell: function () { return new sap.m.Text({ text: "{recon>Lifnr}" }); } },
          { id: "col7", label: "Code", field: "Vcode", width: "6rem", cell: function () { return new sap.m.Text({ text: "{recon>Vcode}" }); } },
          { id: "col12", label: "Object Number", field: "Objnr", width: "9rem", cell: function () { return new sap.m.Text({ text: "{recon>Objnr}" }); } },
          { id: "col13", label: "Object Type", field: "Obtyp", width: "6rem", cell: function () { return new sap.m.Text({ text: "{recon>Obtyp}" }); } },
          { id: "col14", label: "Status", field: "Stat01", width: "6rem", cell: function () { return new sap.m.Text({ text: "{recon>Stat01}" }); } },
          { id: "col15", label: "Characteristic Type", field: "Kzart", width: "7rem", cell: function () { return new sap.m.Text({ text: "{recon>Kzart}" }); } },
          { id: "col16", label: "Order Number", field: "Aufnr", width: "8rem", cell: function () { return new sap.m.Text({ text: "{recon>Aufnr}" }); } },
          { id: "col17", label: "Material Doc.", field: "Mblnr", width: "8rem", cell: function () { return new sap.m.Text({ text: "{recon>Mblnr}" }); } },
        ],
        // Every field LotRejectSet's response actually returns, per the
        // aItems map in onRejectedQtyPress (Prueflos, Werks, Art, Matnr,
        // Maktx, Lifnr, Vcode, Qkennzahl, Charg, Losmenge, Enstehdat) gets
        // its own selectable column here, not just the 7 shown by default â€"
        // see the shared col1..col17 numbering comment above lotsReceivedTable.
        rejectedQtyTable: [
          { id: "col1", label: "Lot Number", field: "Prueflos", width: "9rem", cell: function (that) { return new sap.m.Link({ text: "{recon>Prueflos}", press: that.onLotsReceivedLotNumberPress.bind(that) }); } },
          { id: "col2", label: "Plant", field: "Werks", width: "6rem", cell: function () { return new sap.m.Text({ text: "{recon>Werks}" }); } },
          { id: "col3", label: "Date", field: "Enstehdat", width: "7rem", cell: function (that) { return new sap.m.Text({ text: { path: "recon>Enstehdat", formatter: that.formatOpenItemDate.bind(that) } }); } },
          { id: "col4", label: "Material", field: "Matnr", width: "8rem", cell: function () { return new sap.m.Text({ text: "{recon>Matnr}", wrapping: false }); } },
          { id: "col5", label: "Material Description", field: "Maktx", width: "10rem", cell: function () { return new sap.m.Text({ text: "{recon>Maktx}", wrapping: false }); } },
          { id: "col6", label: "Batch", field: "Charg", width: "7rem", cell: function () { return new sap.m.Text({ text: "{recon>Charg}" }); } },
          { id: "col7", label: "Reject Code", field: "Vcode", width: "7rem", hAlign: "End", cell: function () { return new sap.m.Text({ text: "{recon>Vcode}" }); } },
          { id: "col8", label: "Lot Quantity", field: "Losmenge", width: "8rem", hAlign: "End", cell: function (that) { return new sap.m.Text({ text: { path: "recon>Losmenge", formatter: that.formatAmount.bind(that) } }); } },
          { id: "col9", label: "Inspection Type", field: "Art", width: "7rem", cell: function () { return new sap.m.Text({ text: "{recon>Art}" }); } },
          { id: "col10", label: "Supplier", field: "Lifnr", width: "7rem", cell: function () { return new sap.m.Text({ text: "{recon>Lifnr}" }); } },
          { id: "col11", label: "Acceptance %", field: "Qkennzahl", width: "7rem", hAlign: "End", cell: function () { return new sap.m.Text({ text: "{recon>Qkennzahl}" }); } },
          { id: "col12", label: "Object Number", field: "Objnr", width: "9rem", cell: function () { return new sap.m.Text({ text: "{recon>Objnr}" }); } },
          { id: "col13", label: "Object Type", field: "Obtyp", width: "6rem", cell: function () { return new sap.m.Text({ text: "{recon>Obtyp}" }); } },
          { id: "col14", label: "Status", field: "Stat01", width: "6rem", cell: function () { return new sap.m.Text({ text: "{recon>Stat01}" }); } },
          { id: "col15", label: "Characteristic Type", field: "Kzart", width: "7rem", cell: function () { return new sap.m.Text({ text: "{recon>Kzart}" }); } },
          { id: "col16", label: "Order Number", field: "Aufnr", width: "8rem", cell: function () { return new sap.m.Text({ text: "{recon>Aufnr}" }); } },
          { id: "col17", label: "Material Doc.", field: "Mblnr", width: "8rem", cell: function () { return new sap.m.Text({ text: "{recon>Mblnr}" }); } },
        ],
        // Every field AcceptSet's response actually returns, per the aItems
        // map in onAcceptedQtyPress (Prueflos, Werks, Art, Matnr, Maktx,
        // Lifnr, Vcode, Qkennzahl, Charg, Mblnr, Losmenge, Enstehdat) gets
        // its own selectable column here, not just the 8 shown by default â€"
        // see the shared col1..col17 numbering comment above lotsReceivedTable.
        acceptedQtyTable: [
          { id: "col1", label: "Lot Number", field: "Prueflos", width: "9rem", cell: function (that) { return new sap.m.Link({ text: "{recon>Prueflos}", press: that.onLotsReceivedLotNumberPress.bind(that) }); } },
          { id: "col2", label: "Plant", field: "Werks", width: "6rem", cell: function () { return new sap.m.Text({ text: "{recon>Werks}" }); } },
          { id: "col3", label: "Date", field: "Enstehdat", width: "7rem", cell: function (that) { return new sap.m.Text({ text: { path: "recon>Enstehdat", formatter: that.formatOpenItemDate.bind(that) } }); } },
          { id: "col4", label: "Material", field: "Matnr", width: "8rem", cell: function () { return new sap.m.Text({ text: "{recon>Matnr}", wrapping: false }); } },
          { id: "col5", label: "Material Description", field: "Maktx", width: "10rem", cell: function () { return new sap.m.Text({ text: "{recon>Maktx}", wrapping: false }); } },
          { id: "col6", label: "Batch", field: "Charg", width: "7rem", cell: function () { return new sap.m.Text({ text: "{recon>Charg}" }); } },
          { id: "col7", label: "Code", field: "Vcode", width: "6rem", cell: function () { return new sap.m.Text({ text: "{recon>Vcode}" }); } },
          { id: "col11", label: "Acceptance %", field: "Qkennzahl", width: "7rem", hAlign: "End", cell: function () { return new sap.m.Text({ text: "{recon>Qkennzahl}" }); } },
          { id: "col8", label: "Lot Quantity", field: "Losmenge", width: "8rem", hAlign: "End", cell: function (that) { return new sap.m.Text({ text: { path: "recon>Losmenge", formatter: that.formatAmount.bind(that) } }); } },
          { id: "col9", label: "Inspection Type", field: "Art", width: "7rem", cell: function () { return new sap.m.Text({ text: "{recon>Art}" }); } },
          { id: "col10", label: "Supplier", field: "Lifnr", width: "7rem", cell: function () { return new sap.m.Text({ text: "{recon>Lifnr}" }); } },
          { id: "col17", label: "Material Doc.", field: "Mblnr", width: "8rem", cell: function () { return new sap.m.Text({ text: "{recon>Mblnr}" }); } },
          { id: "col12", label: "Object Number", field: "Objnr", width: "9rem", cell: function () { return new sap.m.Text({ text: "{recon>Objnr}" }); } },
          { id: "col13", label: "Object Type", field: "Obtyp", width: "6rem", cell: function () { return new sap.m.Text({ text: "{recon>Obtyp}" }); } },
          { id: "col14", label: "Status", field: "Stat01", width: "6rem", cell: function () { return new sap.m.Text({ text: "{recon>Stat01}" }); } },
          { id: "col15", label: "Characteristic Type", field: "Kzart", width: "7rem", cell: function () { return new sap.m.Text({ text: "{recon>Kzart}" }); } },
          { id: "col16", label: "Order Number", field: "Aufnr", width: "8rem", cell: function () { return new sap.m.Text({ text: "{recon>Aufnr}" }); } },
        ],
        // Every field LotAUDSet's response actually returns, per the
        // aItems map in onAudQtyPress (Prueflos, Werks, Art, Matnr, Maktx,
        // Lifnr, Vcode, Qkennzahl, Charg, Mblnr, Losmenge, Enstehdat) gets
        // its own selectable column here, not just the 8 shown by default â€"
        // see the shared col1..col17 numbering comment above lotsReceivedTable.
        audQtyTable: [
          { id: "col1", label: "Lot Number", field: "Prueflos", width: "9rem", cell: function () { return new sap.m.Text({ text: "{recon>Prueflos}" }); } },
          { id: "col2", label: "Plant", field: "Werks", width: "6rem", cell: function () { return new sap.m.Text({ text: "{recon>Werks}" }); } },
          { id: "col3", label: "Date", field: "Enstehdat", width: "7rem", cell: function (that) { return new sap.m.Text({ text: { path: "recon>Enstehdat", formatter: that.formatOpenItemDate.bind(that) } }); } },
          { id: "col4", label: "Material", field: "Matnr", width: "8rem", cell: function () { return new sap.m.Text({ text: "{recon>Matnr}", wrapping: false }); } },
          { id: "col5", label: "Material Description", field: "Maktx", width: "10rem", cell: function () { return new sap.m.Text({ text: "{recon>Maktx}", wrapping: false }); } },
          { id: "col6", label: "Batch", field: "Charg", width: "7rem", cell: function () { return new sap.m.Text({ text: "{recon>Charg}" }); } },
          { id: "col7", label: "Code", field: "Vcode", width: "6rem", cell: function () { return new sap.m.Text({ text: "{recon>Vcode}" }); } },
          { id: "col11", label: "Acceptance %", field: "Qkennzahl", width: "7rem", hAlign: "End", cell: function () { return new sap.m.Text({ text: "{recon>Qkennzahl}" }); } },
          { id: "col8", label: "Lot Quantity", field: "Losmenge", width: "8rem", hAlign: "End", cell: function (that) { return new sap.m.Text({ text: { path: "recon>Losmenge", formatter: that.formatAmount.bind(that) } }); } },
          { id: "col9", label: "Inspection Type", field: "Art", width: "7rem", cell: function () { return new sap.m.Text({ text: "{recon>Art}" }); } },
          { id: "col10", label: "Supplier", field: "Lifnr", width: "7rem", cell: function () { return new sap.m.Text({ text: "{recon>Lifnr}" }); } },
          { id: "col17", label: "Material Doc.", field: "Mblnr", width: "8rem", cell: function () { return new sap.m.Text({ text: "{recon>Mblnr}" }); } },
          { id: "col12", label: "Object Number", field: "Objnr", width: "9rem", cell: function () { return new sap.m.Text({ text: "{recon>Objnr}" }); } },
          { id: "col13", label: "Object Type", field: "Obtyp", width: "6rem", cell: function () { return new sap.m.Text({ text: "{recon>Obtyp}" }); } },
          { id: "col14", label: "Status", field: "Stat01", width: "6rem", cell: function () { return new sap.m.Text({ text: "{recon>Stat01}" }); } },
          { id: "col15", label: "Characteristic Type", field: "Kzart", width: "7rem", cell: function () { return new sap.m.Text({ text: "{recon>Kzart}" }); } },
          { id: "col16", label: "Order Number", field: "Aufnr", width: "8rem", cell: function () { return new sap.m.Text({ text: "{recon>Aufnr}" }); } },
        ],
      },

      /**
       * Rebuilds ONE MM/QM table's columns from a selected+ordered list of
       * column ids, using that table's own MM_QM_COLUMN_DEFS entry â€" the
       * MM/QM equivalent of _applyOpenItemsColumnSelection (which is FI-only
       * and always broadcasts to every FI table since they share one
       * schema). Ids the active table doesn't define are silently skipped
       * instead of applied, since MM/QM tables' own schemas differ from
       * each other too (e.g. Total PO's oiCol6 is "Net Value", Material
       * Receipts' oiCol6 is "Mvt Type").
       */
      _applyCategoryColumnSelection: function (sTableId, aSelectedColumnIds) {
        var oTable = this.byId(sTableId);
        var aDefs = this.MM_QM_COLUMN_DEFS[sTableId];
        if (!oTable || !aDefs) return;
        var that = this;

        oTable.destroyColumns();

        aSelectedColumnIds.forEach(function (sColId) {
          var oDef = aDefs.find(function (o) {
            return o.id === sColId;
          });
          if (!oDef) return;
          var oColumn = new sap.ui.table.Column({
            width: oDef.width || "8rem",
            hAlign: oDef.hAlign || "Begin",
            sortProperty: oDef.field,
            filterProperty: oDef.field,
            label: new sap.m.Label({ text: oDef.label, design: "Bold" }),
            template: oDef.cell(that),
          });
          oColumn.data("colId", sColId);
          oTable.addColumn(oColumn);
        });
      },

      /**
       * Swaps oiColumnModel's /columns to whichever table triggered the
       * Column Settings dialog most recently â€" FI's shared 15-field list
       * for the six FI tables, or that specific MM/QM table's own real
       * columns â€" so the dialog never shows field names that don't exist
       * on the table it was opened from.
       */
      _setOiColumnModelForActiveTable: function () {
        var aDefs;
        if (this._sActiveOiCategory === "FI") {
          aDefs = this._oiColumnMap;
        } else {
          aDefs = (this.MM_QM_COLUMN_DEFS[this._sActiveOiTableId] || []).map(
            function (o) {
              return { id: o.id, label: o.label };
            },
          );
        }
        this.getView().getModel("oiColumnModel").setProperty("/columns", aDefs);
      },

      /** Opens the multi-select checkbox Filter popover for whichever table's Filter button was pressed, populated with that table's fixed value list per _oiFilterFieldMap. */
      onLineItemsFilterPress: function (oEvent) {
        var oView = this.getView();
        var oButton = oEvent.getSource();
        var sTableId = oButton.data("tableId") || "transactionsTable";
        var oFieldDef = this._oiFilterFieldMap[sTableId];
        if (!oFieldDef) return;

        this._sActiveOiFilterTableId = sTableId;
        oView.setModel(
          new JSONModel({ label: "Filter: " + oFieldDef.label, values: oFieldDef.values }),
          "oiFilterModel",
        );

        var that = this;
        if (!this._oOiFilterPopover) {
          Fragment.load({
            id: oView.getId(),
            name: "supplieropenitems.view.fragment.OpenItemsFilterPopover",
            controller: this,
          }).then(function (oPopover) {
            that._oOiFilterPopover = oPopover;
            oView.addDependent(oPopover);
            that._preselectOpenItemsFilterValues(sTableId);
            oPopover.openBy(oButton);
          });
        } else {
          this._preselectOpenItemsFilterValues(sTableId);
          this._oOiFilterPopover.openBy(oButton);
        }
      },

      /** Re-ticks the checkbox list to whichever keys were selected the last time this table's filter was opened (empty the first time). */
      _preselectOpenItemsFilterValues: function (sTableId) {
        var oList = this.byId("oiFilterList");
        if (!oList) return;
        var aSelectedKeys =
          (this._oiActiveFilterKeys && this._oiActiveFilterKeys[sTableId]) || [];
        oList.getItems().forEach(function (oItem) {
          var sKey = oItem.getBindingContext("oiFilterModel").getProperty("key");
          oItem.setSelected(aSelectedKeys.indexOf(sKey) > -1);
        });
      },

      // Tracks the checked values so re-opening the popover remembers them â€"
      // doesn't touch the table's data/binding yet.
      onOpenItemsFilterSelectionChange: function () {
        var oList = this.byId("oiFilterList");
        var sTableId = this._sActiveOiFilterTableId;
        if (!oList || !sTableId) return;

        var aSelectedKeys = oList.getSelectedItems().map(function (oItem) {
          return oItem.getBindingContext("oiFilterModel").getProperty("key");
        });
        this._oiActiveFilterKeys = this._oiActiveFilterKeys || {};
        this._oiActiveFilterKeys[sTableId] = aSelectedKeys;
      },

      onOpenItemsFilterClear: function () {
        var oList = this.byId("oiFilterList");
        if (oList) {
          oList.removeSelections(true);
        }
        this.onOpenItemsFilterSelectionChange();
      },

      /** Opens the Column Settings dialog, pre-selecting whichever columns are currently visible on the table whose button was pressed. */
      onLineItemsColumnSettingsPress: function (oEvent) {
        var oView = this.getView();
        var that = this;
        this._sActiveOiTableId =
          oEvent.getSource().data("tableId") || "masterDetailTable";
        this._sActiveOiCategory = this._getTableCategory(this._sActiveOiTableId);
        this._setOiColumnModelForActiveTable();

        if (!this._oOiColumnDialog) {
          Fragment.load({
            id: oView.getId(),
            name: "supplieropenitems.view.fragment.OpenItemsColumnSettings",
            controller: this,
          }).then(function (oDialog) {
            that._oOiColumnDialog = oDialog;
            oView.addDependent(oDialog);
            that._preselectOpenItemsColumnList();
            oDialog.open();
          });
        } else {
          this._preselectOpenItemsColumnList();
          this._oOiColumnDialog.open();
        }
      },

      /** Ticks the column-list items matching the columns visible right now on whichever table triggered the dialog (_sActiveOiTableId). */
      _preselectOpenItemsColumnList: function () {
        var oTable = this.byId(this._sActiveOiTableId || "masterDetailTable");
        var oList = this.byId("oiColumnSelectorList");
        if (!oTable || !oList) return;

        var aVisibleKeys = oTable.getColumns().map(function (oColumn) {
          return oColumn.data("colId");
        });

        oList.getItems().forEach(function (oItem) {
          var oCustomData = oItem
            .getCustomData()
            .find(function (cd) {
              return cd.getKey() === "key";
            });
          var sColId = oCustomData && oCustomData.getValue();
          oItem.setSelected(aVisibleKeys.includes(sColId));
        });
      },

      onOpenItemsColumnSearch: function (oEvent) {
        var sQuery = (oEvent.getParameter("newValue") || "").toLowerCase();
        var oList = this.byId("oiColumnSelectorList");
        oList.getItems().forEach(function (oItem) {
          var sText = oItem.getContent()[0].getItems()[0].getText().toLowerCase();
          oItem.setVisible(sText.includes(sQuery));
        });
      },

      onOpenItemsDropColumnOrder: function (oEvent) {
        var oDraggedItem = oEvent.getParameter("draggedControl");
        var oDroppedItem = oEvent.getParameter("droppedControl");
        var sDropPosition = oEvent.getParameter("dropPosition");
        var oList = this.byId("oiColumnSelectorList");

        var iDragIndex = oList.indexOfItem(oDraggedItem);
        var iDropIndex = oList.indexOfItem(oDroppedItem);
        if (iDragIndex < 0 || iDropIndex < 0) return;

        oList.removeItem(oDraggedItem);
        var iNewIndex = sDropPosition === "After" ? iDropIndex + 1 : iDropIndex;
        if (iDragIndex < iNewIndex) iNewIndex -= 1;
        oList.insertItem(oDraggedItem, iNewIndex);
      },

      onOpenItemsMoveItemUp: function (oEvent) {
        var oList = this.byId("oiColumnSelectorList");
        var oItem = oEvent.getSource().getParent().getParent().getParent();
        var iIndex = oList.indexOfItem(oItem);
        if (iIndex > 0) {
          oList.removeItem(oItem);
          oList.insertItem(oItem, iIndex - 1);
        }
      },

      onOpenItemsMoveItemDown: function (oEvent) {
        var oList = this.byId("oiColumnSelectorList");
        var oItem = oEvent.getSource().getParent().getParent().getParent();
        var iIndex = oList.indexOfItem(oItem);
        if (iIndex < oList.getItems().length - 1) {
          oList.removeItem(oItem);
          oList.insertItem(oItem, iIndex + 1);
        }
      },

      onOpenItemsMoveItemFirst: function (oEvent) {
        var oList = this.byId("oiColumnSelectorList");
        var oItem = oEvent.getSource().getParent().getParent().getParent();
        if (oList.indexOfItem(oItem) > 0) {
          oList.removeItem(oItem);
          oList.insertItem(oItem, 0);
        }
      },

      onOpenItemsMoveItemLast: function (oEvent) {
        var oList = this.byId("oiColumnSelectorList");
        var oItem = oEvent.getSource().getParent().getParent().getParent();
        var iIndex = oList.indexOfItem(oItem);
        if (iIndex < oList.getItems().length - 1) {
          oList.removeItem(oItem);
          oList.insertItem(oItem, oList.getItems().length);
        }
      },

      /** Reads the checked items off oiColumnSelectorList in their current visual order â€" [{key, title}]. */
      _getOpenItemsSelectedColumns: function () {
        var oList = this.byId("oiColumnSelectorList");
        return oList
          .getSelectedItems()
          .map(function (oItem) {
            var oCustomData = oItem
              .getCustomData()
              .find(function (cd) {
                return cd.getKey() === "key";
              });
            return {
              key: oCustomData ? oCustomData.getValue() : null,
              title: oItem.getContent()[0].getItems()[0].getText(),
            };
          })
          .filter(function (o) {
            return o.key !== null;
          });
      },

      onOpenItemsColumnSettingsConfirm: function () {
        var aSelected = this._getOpenItemsSelectedColumns();
        var aSelectedKeys = aSelected.map(function (o) {
          return o.key;
        });

        if (aSelectedKeys.length === 0) {
          MessageToast.show("Please select at least one column.");
          return;
        }

        // FI's six tables share one schema, so a selection broadcasts to
        // all of them (unchanged behavior); MM/QM tables each have their
        // own real columns, so the selection only ever applies to the one
        // table the dialog was opened from.
        if (this._sActiveOiCategory === "FI") {
          this._applyColumnSelectionToAllTables(aSelectedKeys);
        } else {
          this._applyCategoryColumnSelection(this._sActiveOiTableId, aSelectedKeys);
        }

        if (this._oOiColumnDialog) {
          this._oOiColumnDialog.close();
        }

        this._showSaveOpenItemsLayoutDialog(aSelectedKeys);
      },

      onOpenItemsColumnSettingsCancel: function () {
        if (this._oOiColumnDialog) {
          this._oOiColumnDialog.close();
        }
      },

      /** column id -> display label, single source of truth shared by the column dialog and rebuilt headers. */
      _getOpenItemsColumnLabelById: function (sColId) {
        var oCol = this._oiColumnMap.find(function (o) {
          return o.id === sColId;
        });
        return oCol ? oCol.label : sColId;
      },

      /**
       * column id -> the JSON model field it's bound to â€" mirrors
       * _getOpenItemsCellByColumnId's switch, used to wire sortProperty/
       * filterProperty on the dynamically rebuilt masterDetailTable columns
       * so every column gets the same built-in header Sort/Filter menu that
       * the static per-panel tables get directly in XML.
       */
      _getOpenItemsFieldByColumnId: function (sColId) {
        switch (sColId) {
          case "oiCol1":
            return "Belnr";
          case "oiCol2":
            return "Budat";
          case "oiCol3":
            return "Blart";
          case "oiCol4":
            return "NetAmt";
          case "oiCol5":
            return "Augbl";
          case "oiCol6":
            return "Bukrs";
          case "oiCol7":
            return "Lifnr";
          case "oiCol8":
            return "Name1";
          case "oiCol9":
            return "Sgtxt";
          case "oiCol10":
            return "Rebzg";
          case "oiCol11":
            return "Waers";
          case "oiCol12":
            return "Bstat";
          case "oiCol13":
            return "Bldat";
          case "oiCol14":
            return "Umskz";
          case "oiCol15":
            return "Shkzg";
          default:
            return null;
        }
      },

      /** column id -> the actual cell control template used inside masterDetailTable â€" mirrors the fixed columns further up this file. */
      _getOpenItemsCellByColumnId: function (sColId) {
        switch (sColId) {
          case "oiCol1": // Document
            return new sap.m.Text({ text: "{recon>Belnr}" });
          case "oiCol2": // Date
            return new sap.m.Text({
              text: {
                path: "recon>Budat",
                formatter: this.formatOpenItemDate.bind(this),
              },
            });
          case "oiCol3": // Type
            return new sap.m.Text({ text: "{recon>Blart}", wrapping: false });
          case "oiCol4": // Amount
            return new sap.m.ObjectNumber({
              number: {
                path: "recon>NetAmt",
                formatter: this.formatAmount.bind(this),
              },
            });
          case "oiCol5": // Status
            return new sap.m.ObjectStatus({
              text: {
                path: "recon>Augbl",
                formatter: this.formatOpenItemStatus.bind(this),
              },
              state: {
                path: "recon>Augbl",
                formatter: this.formatOpenItemStatusState.bind(this),
              },
            });
          case "oiCol6": // Company Code
            return new sap.m.Text({ text: "{recon>Bukrs}" });
          case "oiCol7": // Supplier
            return new sap.m.Text({ text: "{recon>Lifnr}" });
          case "oiCol8": // Supplier Name
            return new sap.m.Text({ text: "{recon>Name1}" });
          case "oiCol9": // Text
            return new sap.m.Text({ text: "{recon>Sgtxt}", wrapping: false });
          case "oiCol10": // Reference
            return new sap.m.Text({ text: "{recon>Rebzg}" });
          case "oiCol11": // Currency
            return new sap.m.Text({ text: "{recon>Waers}" });
          case "oiCol12": // Posting Status
            return new sap.m.Text({ text: "{recon>Bstat}" });
          case "oiCol13": // Document Date
            return new sap.m.Text({
              text: {
                path: "recon>Bldat",
                formatter: this.formatOpenItemDate.bind(this),
              },
            });
          case "oiCol14": // Special G/L Ind
            return new sap.m.Text({ text: "{recon>Umskz}" });
          case "oiCol15": // Debit/Credit
            return new sap.m.Text({ text: "{recon>Shkzg}" });
          default:
            return new sap.m.Text({ text: "" });
        }
      },

      /**
       * Rebuilds ONE table's columns (sap.ui.table.Table, NOT
       * sap.ui.table.TreeTable â€" a plain grid table) from a selected+ordered
       * list of column ids: destroys every column and re-adds them in that
       * order, each carrying its own bound cell template. Rows stay bound to
       * whatever that table's own "rows" aggregation already points at
       * (recon>/openItems, recon>/transactionItems, â€¦) throughout â€" only the
       * columns aggregation changes.
       *
       * Widths are fixed rem values per column (OI_COLUMN_WIDTHS below)
       * instead of an even 100/count percentage split â€" with up to 15
       * columns now selectable, splitting evenly would squeeze every
       * column down to an unreadable sliver. Fixed widths let columns
       * keep a sane minimum size and the table's own
       * horizontalScrolling="true" kicks in to scroll through the rest,
       * instead of everything shrinking to fit.
       */
      OI_COLUMN_WIDTHS: {
        oiCol1: "8rem", // Document
        oiCol2: "7rem", // Date
        oiCol3: "8rem", // Type
        oiCol4: "8rem", // Amount
        oiCol5: "6rem", // Status
        oiCol6: "6rem", // Company Code
        oiCol7: "7rem", // Supplier
        oiCol8: "10rem", // Supplier Name
        oiCol9: "10rem", // Text
        oiCol10: "7rem", // Reference
        oiCol11: "6rem", // Currency
        oiCol12: "7rem", // Posting Status
        oiCol13: "7rem", // Document Date
        oiCol14: "7rem", // Special G/L Ind
        oiCol15: "7rem", // Debit/Credit
      },

      _applyOpenItemsColumnSelection: function (sTableId, aSelectedColumnIds) {
        var oTable = this.byId(sTableId);
        if (!oTable) return;
        var that = this;

        // Don't apply column selection to Lots Received table - use fragment's template with Link
        if (sTableId === "lotsReceivedTable") {
          return;
        }

        oTable.destroyColumns();

        aSelectedColumnIds.forEach(function (sColId) {
          var sField = that._getOpenItemsFieldByColumnId(sColId);
          var oColumn = new sap.ui.table.Column({
            width: that.OI_COLUMN_WIDTHS[sColId] || "8rem",
            hAlign: sColId === "oiCol4" || sColId === "oiCol5" ? "End" : "Begin",
            sortProperty: sField,
            filterProperty: sField,
            label: new sap.m.Label({
              text: that._getOpenItemsColumnLabelById(sColId),
              
            }),
            template: that._getOpenItemsCellByColumnId(sColId),
          });
          oColumn.data("colId", sColId);
          oTable.addColumn(oColumn);
        });
      },

      /**
       * Broadcasts a column selection+order to EVERY master-detail line-items
       * table (OI_TABLE_IDS) â€" this is what makes "select/save a layout"
       * apply the same layout everywhere instead of just the panel the
       * dialog happened to be opened from.
       */
      _applyColumnSelectionToAllTables: function (aSelectedColumnIds) {
        var that = this;
        this.OI_TABLE_IDS.forEach(function (sTableId) {
          that._applyOpenItemsColumnSelection(sTableId, aSelectedColumnIds);
        });
      },

      // â"€â"€â"€ Select Layout (backend-persisted via LayoutSet) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
      //
      // Layouts are stored server-side in ZSUPPLIER_DLT_SRV's LayoutSet
      // (key: LayoutName), not localStorage â€" GET/POST/MERGE/DELETE against
      // that entity set instead of reading/writing a browser key. Its shape,
      // confirmed against a live response:
      //   { LayoutName: "TEST", Default: "X" | "", Columns: "oiCol1,oiCol3,...", Category: "FI" }
      // "Default" is a flag character ("X"/"") like any other SAP checkbox
      // field, not a boolean. Category is "FI"/"MM"/"QM" â€" every GET is
      // filtered to one category and every POST tags the row with one (see
      // TABLE_CATEGORY/_getTableCategory), so a layout saved while
      // configuring an MM or QM table never shows up (or gets applied) on
      // an unrelated section. _oiSavedLayoutsByCategory keeps one
      // {LayoutName, Columns, Default, Category} array per category; Default
      // is normalized to a real boolean the moment a row comes back from the
      // backend (see _mapLayoutSetRow), and converted back to "X"/"" only
      // right before it goes out over the wire.

      /** LayoutSet row -> {LayoutName, Columns, Default: boolean, Category} shape the rest of this file already works with. */
      _mapLayoutSetRow: function (o) {
        // Older rows saved before this field existed have no Category on
        // the backend â€" treat those as FI (the section that always had
        // this feature) rather than dropping them. Computed up front since
        // backendColIdToOi needs it to know whether to run the oiColN<->
        // colN transform (FI only) or leave MM/QM's own "col<N>" ids as-is.
        var sCategory = o.Category || "FI";
        return {
          LayoutName: o.LayoutName,
          Columns: (o.Columns || "")
            .split(",")
            .filter(Boolean)
            .map(function (sId) {
              return backendColIdToOi(sId, sCategory);
            })
            .join(","),
          Default: o.Default === "X" || o.Default === true,
          Category: sCategory,
        };
      },

      /** _oiSavedLayoutsByCategory[category], creating an empty array the first time that category is touched. */
      _getSavedLayoutsForCategory: function (sCategory) {
        return (
          this._oiSavedLayoutsByCategory[sCategory] ||
          (this._oiSavedLayoutsByCategory[sCategory] = [])
        );
      },

      /** Shorthand for _getSavedLayoutsForCategory(this._sActiveOiCategory). */
      _getActiveSavedLayouts: function () {
        return this._getSavedLayoutsForCategory(this._sActiveOiCategory || "FI");
      },

      /**
       * Reads LayoutSet filtered to one Category (FI/MM/QM) into
       * oiLayoutModel, caching the result so re-opening Column Settings/
       * Select Layout on the same category doesn't re-fetch. Applies
       * whichever row is Default once the read (or cache) is in. sCategory
       * is sent as an actual $filter on the GET so each section only ever
       * pulls its own rows back, not the whole LayoutSet table.
       */
      _ensureLayoutsLoadedForCategory: function (sCategory, fnAfter) {
        var that = this;

        if (this._oiSavedLayoutsByCategory[sCategory]) {
          this.getView().setModel(
            new JSONModel({ layouts: this._oiSavedLayoutsByCategory[sCategory] }),
            "oiLayoutModel",
          );
          if (fnAfter) fnAfter();
          return;
        }

        var oModel = this.getOwnerComponent().getModel();

        oModel.read("/LayoutSet", {
          filters: [new Filter("Category", FilterOperator.EQ, sCategory)],
          success: function (oData) {
            // The backend doesn't actually honor the $filter above (it
            // hands back every LayoutSet row regardless of Category), so
            // without this client-side filter every category's dialog
            // would show every other category's layouts too. Re-filter
            // here as the real enforcement point.
            var aLayouts = (oData.results || [])
              .map(that._mapLayoutSetRow)
              .filter(function (o) {
                return o.Category === sCategory;
              });
            that._oiSavedLayoutsByCategory[sCategory] = aLayouts;
            that.getView().setModel(
              new JSONModel({ layouts: aLayouts }),
              "oiLayoutModel",
            );
            that._applyDefaultOpenItemsLayoutForCategory(sCategory);
            if (fnAfter) fnAfter();
          },
          error: function () {
            that._oiSavedLayoutsByCategory[sCategory] = [];
            that.getView().setModel(
              new JSONModel({ layouts: [] }),
              "oiLayoutModel",
            );
            MessageToast.show("Error loading saved layouts.");
            if (fnAfter) fnAfter();
          },
        });
      },

      /**
       * Persists one LayoutSet row (tagged with its Category) and re-syncs
       * oiLayoutModel from that category's in-memory list on success â€"
       * callers pass a plain {LayoutName, Columns, Default: boolean,
       * Category} object with Columns in this app's internal "oiCol1"..
       * scheme (translated to the backend's "col1".. scheme here, right
       * before the request goes out).
       *
       * Overwriting an existing LayoutName goes through DELETE_ENTITY then
       * CREATE_ENTITY rather than a MERGE/update() â€" this backend's
       * LAYOUTSET_UPDATE_ENTITY isn't implemented (confirmed: MERGE
       * LayoutSet('B') came back "HTTP/1.1 501 Not Implemented"), so a plain
       * update() would always fail here even though the entity set itself
       * supports create/delete fine.
       */
      _saveLayoutToBackend: function (oLayout, fnSuccess, fnError) {
        this._saveLayoutsBatchToBackend([oLayout], fnSuccess, fnError);
      },

      /**
       * Persists any number of LayoutSet rows in as few backend round
       * trips as possible, instead of one remove+create pair per layout
       * fired back-to-back (which is what _setBackendLayoutDefault used to
       * do via a loop of individual _saveLayoutToBackend calls â€" clearing
       * one previous default plus setting a new one meant 4 sequential
       * $batch requests for a single "Set as Default" click).
       *
       * Overwriting an existing LayoutName goes through DELETE_ENTITY then
       * CREATE_ENTITY rather than a MERGE/update() â€" this backend's
       * LAYOUTSET_UPDATE_ENTITY isn't implemented (confirmed: MERGE
       * LayoutSet('B') came back "HTTP/1.1 501 Not Implemented"). Since the
       * create for an existing row can only go out once its delete has
       * actually committed (same key), this still needs two phases â€" a
       * "remove all existing rows being touched" batch, then a "create all
       * rows" batch â€" but each phase is exactly ONE $batch request no
       * matter how many layouts are involved, each row's operation living
       * in its own changeset (the backend's default changeset
       * implementation allows only one operation per changeset â€" batching
       * two together returned "Default changeset implementation allows
       * only one operation", /IWBEP/CM_MGW_RT/053).
       */
      _saveLayoutsBatchToBackend: function (aLayouts, fnSuccess, fnError) {
        var oModel = this.getOwnerComponent().getModel();
        var that = this;
        var onError =
          fnError ||
          function () {
            MessageToast.show("Error saving layout to the backend.");
          };

        var aOps = aLayouts.map(function (oLayout) {
          var sCategory = oLayout.Category || that._sActiveOiCategory || "FI";
          var aSaved = that._getSavedLayoutsForCategory(sCategory);
          var bExists = aSaved.some(function (o) {
            return o.LayoutName === oLayout.LayoutName;
          });
          return {
            oLayout: oLayout,
            sCategory: sCategory,
            aSaved: aSaved,
            bExists: bExists,
            oPayload: {
              LayoutName: oLayout.LayoutName,
              Columns: oLayout.Columns
                .split(",")
                .filter(Boolean)
                .map(function (sId) {
                  return oiColIdToBackend(sId, sCategory);
                })
                .join(","),
              Default: oLayout.Default ? "X" : "",
              Category: sCategory,
            },
          };
        });

        function applyLocally() {
          aOps.forEach(function (op) {
            var oStored = {
              LayoutName: op.oLayout.LayoutName,
              Columns: op.oLayout.Columns,
              Default: op.oLayout.Default,
              Category: op.sCategory,
            };
            var iIndex = op.aSaved.findIndex(function (o) {
              return o.LayoutName === op.oLayout.LayoutName;
            });
            if (iIndex > -1) {
              op.aSaved[iIndex] = oStored;
            } else {
              op.aSaved.push(oStored);
            }
            if (that._sActiveOiCategory === op.sCategory) {
              that.getView().getModel("oiLayoutModel").setProperty(
                "/layouts",
                op.aSaved,
              );
            }
          });
          if (fnSuccess) fnSuccess();
        }

        function queueCreatesAndSubmit() {
          aOps.forEach(function (op) {
            var sGroupId = "oiLayoutSave_" + oiLayoutSaveCounter++;
            oModel.setDeferredGroups(
              oModel.getDeferredGroups().concat([sGroupId]),
            );
            // refreshAfterChange:false â€" ODataModel.create() defaults to
            // true, which re-reads the entity right after the write
            // (calling the backend's GET_ENTITY handler) purely to sync
            // change-tracking. LayoutSet doesn't need that round trip, and
            // if GET_ENTITY isn't wired up either it'd make a successful
            // CREATE_ENTITY look like a failure. applyLocally already
            // updates the local model from what was sent, so the refetch
            // buys nothing here.
            oModel.create("/LayoutSet", op.oPayload, {
              groupId: sGroupId,
              refreshAfterChange: false,
            });
          });
          oModel.submitChanges({
            success: applyLocally,
            error: onError,
          });
        }

        var aExisting = aOps.filter(function (op) {
          return op.bExists;
        });

        if (!aExisting.length) {
          queueCreatesAndSubmit();
          return;
        }

        aExisting.forEach(function (op) {
          var sGroupId = "oiLayoutSave_" + oiLayoutSaveCounter++;
          oModel.setDeferredGroups(
            oModel.getDeferredGroups().concat([sGroupId]),
          );
          oModel.remove("/LayoutSet('" + op.oLayout.LayoutName + "')", {
            groupId: sGroupId,
          });
        });
        oModel.submitChanges({
          success: queueCreatesAndSubmit,
          error: onError,
        });
      },

      /**
       * Applies whichever saved layout has Default:true for this category,
       * if any — called once that category's LayoutSet read (or cache) is
       * in. FI broadcasts to all six FI tables (identical schema). MM/QM
       * now broadcasts the same way, to every table tagged with that
       * category in TABLE_CATEGORY, not just whichever table happened to
       * be "active" (i.e. had Column Settings opened on it most recently)
       * — this is what lets a saved MM/QM default layout apply the moment
       * the page loads/searches, same as FI, instead of only after a panel's
       * Column Settings dialog has been opened at least once. This is safe
       * even though MM/QM tables' schemas differ from each other:
       * _applyCategoryColumnSelection resolves each column id against the
       * TARGET table's own MM_QM_COLUMN_DEFS entry (label/cell come from
       * that table, not from whichever table the layout was saved on), and
       * silently skips any id the target table doesn't define.
       */
      _applyDefaultOpenItemsLayoutForCategory: function (sCategory) {
        var aLayouts = this._getSavedLayoutsForCategory(sCategory);
        var oDefault = aLayouts.find(function (o) {
          return o.Default;
        });
        if (!oDefault) return;

        if (sCategory === "FI") {
          this._applyColumnSelectionToAllTables(oDefault.Columns.split(","));
          return;
        }

        this._applyColumnSelectionToCategoryTables(
          sCategory,
          oDefault.Columns.split(","),
        );
      },

      /**
       * Broadcasts one column selection to every MM/QM table tagged with
       * sCategory in TABLE_CATEGORY (skipping any not yet in the DOM) â€"
       * shared by _applyDefaultOpenItemsLayoutForCategory (applying the
       * saved Default on load) and onOpenItemsApplyLayout (applying
       * whichever layout was just picked in the Select Layout dialog, even
       * when it isn't being marked Default). Safe even though MM/QM
       * tables' schemas differ from each other: _applyCategoryColumnSelection
       * resolves each column id against the TARGET table's own
       * MM_QM_COLUMN_DEFS entry (label/cell come from that table, not from
       * whichever table the layout was saved on), and silently skips any
       * id the target table doesn't define.
       */
      _applyColumnSelectionToCategoryTables: function (sCategory, aColumnIds) {
        var that = this;
        Object.keys(this.TABLE_CATEGORY).forEach(function (sTableId) {
          if (that.TABLE_CATEGORY[sTableId] !== sCategory) return;
          if (!that.byId(sTableId)) return;
          that._applyCategoryColumnSelection(sTableId, aColumnIds);
        });
      },

      /**
       * Clears Default on every OTHER layout in sCategory (LayoutSet has no
       * separate "current default" pointer â€" Default is a per-row flag, so
       * only ever one row may hold it at a time). Split out of
       * _setBackendLayoutDefault so the Save-layout dialog's "Make Default"
       * checkbox can reuse it without also re-saving the layout that was
       * just created/updated a second time (that layout is already saved
       * with Default:true by the caller before this runs) â€" previously
       * every "create as default" went out as an extra, fully redundant
       * delete+create pair on top of the real save, doubling the batch
       * calls for no reason.
       */
      _clearOtherBackendDefaults: function (sCategory, sKeepLayoutName, fnSuccess, fnError) {
        var aSaved = this._getSavedLayoutsForCategory(sCategory);
        var aPreviousDefaults = aSaved.filter(function (o) {
          return o.Default && o.LayoutName !== sKeepLayoutName;
        });
        if (!aPreviousDefaults.length) {
          if (fnSuccess) fnSuccess();
          return;
        }
        this._saveLayoutsBatchToBackend(
          aPreviousDefaults.map(function (o) {
            return {
              LayoutName: o.LayoutName,
              Columns: o.Columns,
              Default: false,
              Category: sCategory,
            };
          }),
          fnSuccess,
          fnError,
        );
      },

      /**
       * Marks sLayoutName (an EXISTING, already-saved layout) as the
       * Default layout within the active category on the backend, clearing
       * Default on whichever layout previously held it. Used by the Select
       * Layout dialog's own "Set as Default" action, where the target
       * layout isn't otherwise being touched â€" unlike the Save-layout
       * dialog's "Make Default" checkbox, which saves the target with
       * Default:true directly and only needs _clearOtherBackendDefaults,
       * not a second save of the target through here.
       *
       * The previous-default clear(s) and the target's own save go through
       * _saveLayoutsBatchToBackend TOGETHER as one call, so this whole
       * "set as default" action costs exactly 2 backend round trips (one
       * batch of removes, one batch of creates) no matter how many rows
       * are touched, instead of a separate remove+create pair per row.
       */
      _setBackendLayoutDefault: function (sLayoutName) {
        var that = this;
        var sCategory = this._sActiveOiCategory || "FI";
        var aSaved = this._getActiveSavedLayouts();

        var oTarget = aSaved.find(function (o) {
          return o.LayoutName === sLayoutName;
        });
        if (!oTarget) return;

        var aPreviousDefaults = aSaved.filter(function (o) {
          return o.Default && o.LayoutName !== sLayoutName;
        });
        var aLayouts = aPreviousDefaults
          .map(function (o) {
            return {
              LayoutName: o.LayoutName,
              Columns: o.Columns,
              Default: false,
              Category: sCategory,
            };
          })
          .concat([
            {
              LayoutName: sLayoutName,
              Columns: oTarget.Columns,
              Default: true,
              Category: sCategory,
            },
          ]);

        this._saveLayoutsBatchToBackend(
          aLayouts,
          function () {
            that.getView().getModel("oiLayoutModel").setProperty("/layouts", aSaved);
            // A plain in-place re-apply (_applyCategoryColumnSelection/
            // onRefreshMasterDetail) was found to not reliably reflect the
            // new default on every table right after the backend save
            // confirms. Forcing a full page reload instead guarantees the
            // normal onInit path re-reads LayoutSet fresh and applies the
            // new Default:true row from scratch, exactly as it does on a
            // manual browser refresh. _persistUiState/_restoreUiState
            // (sessionStorage) already carry Company Code/Supplier/dates
            // and whichever master-detail panel was open across a reload,
            // so this doesn't lose the user's place.
            MessageToast.show("Layout marked as default. Reloading...");
            that.onRefreshPage();
          },
          function () {
            MessageToast.show("Error marking layout as default.");
          },
        );
      },

      /**
       * Full page reload â€" _persistUiState/_restoreUiState (sessionStorage)
       * carry the user's place across it. Sets ALLOW_RESTORE_ONCE_KEY first
       * so _shouldRestoreUiState definitely restores after THIS reload, even
       * when this app is running inside the FLP shell's iframe (where the
       * window.top-based check alone can't tell "we just reloaded on
       * purpose to reflect a saved layout" apart from "the shell silently
       * reloaded this iframe for its own reasons").
       */
      onRefreshPage: function () {
        try {
          window.sessionStorage.setItem(this.ALLOW_RESTORE_ONCE_KEY, "1");
        } catch (e) {
          // sessionStorage unavailable â€" worst case this reload lands on
          // fresh defaults instead of restoring, same as before this flag existed.
        }
        window.location.reload();
      },

      onLineItemsLayoutDialogPress: function (oEvent) {
        var oView = this.getView();
        var that = this;
        this._sActiveOiTableId =
          oEvent.getSource().data("tableId") || "masterDetailTable";
        this._sActiveOiCategory = this._getTableCategory(this._sActiveOiTableId);

        // Loads (or reuses the cached) LayoutSet rows for THIS category
        // only, and points oiLayoutModel at them, before the dialog opens â€"
        // so Select Layout on an MM/QM table only ever lists that
        // category's own saved layouts, never FI's (or another category's).
        this._ensureLayoutsLoadedForCategory(this._sActiveOiCategory, function () {
          if (!that._oOiLayoutDialog) {
            Fragment.load({
              id: oView.getId(),
              name: "supplieropenitems.view.fragment.OpenItemsLayoutDialog",
              controller: that,
            }).then(function (oDialog) {
              that._oOiLayoutDialog = oDialog;
              oView.addDependent(oDialog);
              oDialog.open();
            });
          } else {
            that._oOiLayoutDialog.open();
          }
        });
      },

      onOpenItemsLayoutSelectionChange: function (oEvent) {
        var oSelectedItem = oEvent.getParameter("listItem");
        var oCtx = oSelectedItem.getBindingContext("oiLayoutModel");
        var aLayouts = this.getView()
          .getModel("oiLayoutModel")
          .getProperty("/layouts");

        aLayouts.forEach(function (o) {
          o.selected = false;
        });
        oCtx.getObject().selected = true;

        this.getView().getModel("oiLayoutModel").refresh(true);
      },

      onOpenItemsApplyLayout: function () {
        var aLayouts = this.getView()
          .getModel("oiLayoutModel")
          .getProperty("/layouts");
        var bSetAsDefault = this.byId("oiSetDefaultCheckbox").getSelected();
        var oSelected = aLayouts.find(function (o) {
          return o.selected;
        });

        if (!oSelected) {
          MessageToast.show("Please select a layout to apply.");
          return;
        }

        // When "Set as Default" is checked, _setBackendLayoutDefault ends
        // in a full page reload (see there for why) once the backend save
        // confirms, and that reload re-applies this exact layout to every
        // table itself â€" so the in-place apply below is skipped in that
        // case to avoid a flash of the layout followed immediately by a
        // reload, and by two contradictory MessageToasts stacking up.
        if (bSetAsDefault) {
          this._setBackendLayoutDefault(oSelected.LayoutName);
          this.byId("oiSetDefaultCheckbox").setSelected(false);
          this._oOiLayoutDialog.close();
          return;
        }

        if (this._sActiveOiCategory === "FI") {
          this._applyColumnSelectionToAllTables(oSelected.Columns.split(","));
        } else {
          // Broadcast to every table in the active MM/QM category, not
          // just _sActiveOiTableId (the one Select Layout was opened from)
          // â€" otherwise applying a layout from e.g. Total PO left Material
          // Receipts/Pending PO/etc. still showing their old columns until
          // the page was reloaded (which only re-applies whatever layout
          // is marked Default, not whichever one was just picked here).
          // Same broadcast-to-category-wide behavior FI already had.
          this._applyColumnSelectionToCategoryTables(
            this._sActiveOiCategory,
            oSelected.Columns.split(","),
          );
        }
        MessageToast.show(
          "Applied layout to all sections: " + oSelected.LayoutName,
        );

        this.byId("oiSetDefaultCheckbox").setSelected(false);
        this._oOiLayoutDialog.close();
      },

      onOpenItemsCancelLayout: function () {
        this.byId("oiSetDefaultCheckbox").setSelected(false);
        this._oOiLayoutDialog.close();
      },

      onOpenItemsDeleteLayout: function (oEvent) {
        var oContext = oEvent.getSource().getBindingContext("oiLayoutModel");
        var sLayoutName = oContext.getObject().LayoutName;
        var oModel = this.getOwnerComponent().getModel();
        var that = this;
        var sCategory = this._sActiveOiCategory || "FI";

        oModel.remove("/LayoutSet('" + sLayoutName + "')", {
          success: function () {
            var aSaved = that
              ._getSavedLayoutsForCategory(sCategory)
              .filter(function (o) {
                return o.LayoutName !== sLayoutName;
              });
            that._oiSavedLayoutsByCategory[sCategory] = aSaved;
            that.getView().getModel("oiLayoutModel").setProperty("/layouts", aSaved);
            MessageToast.show("Layout deleted.");
          },
          error: function () {
            MessageToast.show("Error deleting layout from the backend.");
          },
        });
      },

      /** Formatter for the read-only "Default?" checkbox in the layout table. */
      isOpenItemsDefaultChecked: function (vValue) {
        return !!vValue;
      },

      /**
       * The FI header's "From Date" field is greyed out (visible, not
       * hidden) on Opening Balance, Advance Balance, Pending Invoices, and
       * Closing Balance â€" none of those four actually filter by a From
       * Date (Opening Balance/Advance Balance/Closing Balance key off the
       * To Date only, via a single Budat EQ filter â€" see
       * onClosingBalancePress; Pending Invoices has no date filter at
       * all), so leaving the field enabled there would suggest changing it
       * does something when it doesn't. Every other master-detail panel
       * (Transactions, Payments, Total PO, Material Receipts, ...) DOES
       * use From Date, so it stays enabled there, same as on the initial
       * (pre-drill-in) search screen. bAnyOtherPanel mirrors
       * OpenItemsPanel.fragment.xml's own "is Opening Balance showing"
       * visibility check â€" Opening Balance has no mdShowX flag of its
       * own; it's just whatever's left once
       * every other panel's flag is false.
       */
      isFromDateEnabled: function (
        bMasterDetailMode,
        bAdvance,
        bPendingInvoices,
        bGenericModule,
        bTransactions,
        bPayments,
        bDebitNotes,
        bTotalPO,
        bPendingPO,
        bLotsAccepted,
        bLotsReceived,
        bRejectedQty,
        bAcceptedQty,
        bAudQty,
        bMatReceipts,
        bVendorReturns,
        bShareOfBusiness,
        bClosingBalance,
      ) {
        if (!bMasterDetailMode) return true;
        // Closing Balance uses a single "as of" Budat (= To Date only, same
        // as onClosingBalancePress) â€" From Date plays no part in its query,
        // same reasoning as Advance/Pending Invoices above.
        if (bAdvance || bPendingInvoices || bClosingBalance) return false;

        var bAnyOtherPanel =
          bGenericModule ||
          bTransactions ||
          bPayments ||
          bDebitNotes ||
          bTotalPO ||
          bPendingPO ||
          bLotsAccepted ||
          bLotsReceived ||
          bRejectedQty ||
          bAcceptedQty ||
          bAudQty ||
          bMatReceipts ||
          bVendorReturns ||
          bShareOfBusiness;

        // Nothing else showing means Opening Balance (the default panel)
        // is â€" disable, same as Advance/Pending Invoices above.
        return bAnyOtherPanel;
      },

      /**
       * Prompts to save the just-applied column selection as a named,
       * reusable layout â€" same "Do you want to save this Layout?" step the
       * reference app shows right after Column Settings is confirmed.
       */
      _showSaveOpenItemsLayoutDialog: function (aSelectedKeys) {
        var that = this;

        // The dialog itself (and its Save button's press handler) is only
        // ever built once, below â€" reopening it on a later call must NOT
        // rely on aSelectedKeys via closure, since that would freeze the
        // very first selection ever passed in. Stash the current one on
        // `this` instead and have the press handler read it fresh each
        // time the dialog opens.
        this._oiPendingColumnSelection = aSelectedKeys;

        if (!this._oOiSaveLayoutDialog) {
          this._oOiSaveLayoutDialog = new sap.m.Dialog({
            title: "Save this column layout?",
            contentWidth: "22rem",
            content: [
              new sap.m.VBox({
                items: [
                  new sap.m.HBox({
                    alignItems: "Center",
                    items: [
                      new sap.m.Label({
                        text: "Layout Name:",
                        labelFor: "oiLayoutNameInput",
                        width: "7rem",
                      }),
                      new sap.m.Input("oiLayoutNameInput", {
                        width: "100%",
                        placeholder: "Enter layout name",
                      }),
                    ],
                  }).addStyleClass("sapUiSmallMarginBottom"),
                  new sap.m.HBox({
                    alignItems: "Center",
                    items: [
                      new sap.m.Label({
                        text: "Make Default:",
                        labelFor: "oiDefaultLayoutCheckbox",
                        width: "7rem",
                      }),
                      new sap.m.CheckBox("oiDefaultLayoutCheckbox", {
                        selected: false,
                      }),
                    ],
                  }),
                ],
              }).addStyleClass("sapUiContentPadding"),
            ],
            beginButton: new sap.m.Button({
              text: "Save",
              type: "Accept",
              press: function () {
                var sName = sap.ui
                  .getCore()
                  .byId("oiLayoutNameInput")
                  .getValue()
                  .trim();
                var bDefault = sap.ui
                  .getCore()
                  .byId("oiDefaultLayoutCheckbox")
                  .getSelected();

                if (!sName) {
                  MessageToast.show("Please enter a layout name.");
                  return;
                }

                var sNameUpper = sName.toUpperCase();
                var iExistingIndex = that._getActiveSavedLayouts().findIndex(
                  function (o) {
                    return o.LayoutName.toUpperCase() === sNameUpper;
                  },
                );

                var fnSave = function () {
                  var oLayout = {
                    LayoutName: sNameUpper,
                    Columns: that._oiPendingColumnSelection.join(","),
                    Default: bDefault,
                    Category: that._sActiveOiCategory || "FI",
                  };

                  // Reloads the page once the save (create/update) â€" and,
                  // when marking this layout Default, the follow-up
                  // _clearOtherBackendDefaults call â€" have both actually
                  // committed on the backend. Same reasoning as
                  // _setBackendLayoutDefault: an in-place re-apply
                  // (_applyColumnSelectionToAllTables/onRefreshMasterDetail)
                  // wasn't reliably reflecting the saved state everywhere,
                  // so every backend layout mutation (create, update, and
                  // set-default) now ends in a full reload that re-reads
                  // LayoutSet fresh via the normal onInit path.
                  // _persistUiState/_restoreUiState carry the user's place
                  // (Company Code/Supplier/dates/open panel) across it.
                  function reloadAfterSave() {
                    MessageToast.show(
                      (iExistingIndex > -1 ? "Layout updated: " : "Layout saved: ") +
                        sNameUpper +
                        ". Reloading...",
                    );
                    that._oOiSaveLayoutDialog.close();
                    that.onRefreshPage();
                  }

                  that._saveLayoutToBackend(
                    oLayout,
                    function () {
                      // oLayout above was already saved with Default:bDefault
                      // directly, so all that's left is clearing Default on
                      // whichever OTHER row held it before â€" re-saving this
                      // same layout again via _setBackendLayoutDefault would
                      // just be a second, fully redundant delete+create pair.
                      if (bDefault) {
                        that._clearOtherBackendDefaults(
                          oLayout.Category,
                          sNameUpper,
                          reloadAfterSave,
                          reloadAfterSave,
                        );
                      } else {
                        reloadAfterSave();
                      }
                    },
                    function () {
                      MessageToast.show("Error saving layout to the backend.");
                    },
                  );
                };

                if (iExistingIndex > -1) {
                  MessageBox.confirm(
                    "A layout named \"" +
                      sNameUpper +
                      "\" already exists. Overwrite it?",
                    {
                      title: "Confirm Overwrite",
                      actions: [MessageBox.Action.OK, MessageBox.Action.CANCEL],
                      emphasizedAction: MessageBox.Action.OK,
                      onClose: function (sAction) {
                        if (sAction === MessageBox.Action.OK) fnSave();
                      },
                    },
                  );
                } else {
                  fnSave();
                }
              },
            }),
            endButton: new sap.m.Button({
              text: "No, thanks",
              type: "Reject",
              press: function () {
                that._oOiSaveLayoutDialog.close();
              },
            }),
            afterClose: function () {
              sap.ui.getCore().byId("oiLayoutNameInput").setValue("");
              sap.ui.getCore().byId("oiDefaultLayoutCheckbox").setSelected(false);
            },
          });
          this.getView().addDependent(this._oOiSaveLayoutDialog);
        }

        this._oOiSaveLayoutDialog.open();
      },

      /**
       * Switches the Chart/Vendors/Open-Items tab programmatically (used by
       * the IconTabHeader select event and by category/vendor navigation).
       */
      _showTab: function (sKey) {
        var oTabHeader = this.byId("dashboardTabHeader");
        if (oTabHeader) {
          oTabHeader.setSelectedKey(sKey);
        }
        var oChart = this.byId("chartContent");
        var oVendors = this.byId("vendorsContent");
        var oKpi = this.byId("kpiContent");
        if (oChart) oChart.setVisible(sKey === "chart");
        if (oVendors) oVendors.setVisible(sKey === "vendors");
        if (oKpi) oKpi.setVisible(sKey === "kpi");
      },

      onFilterChange: function () {},

      onAdaptFilters: function () {
        MessageToast.show("Filter configuration is not available yet.");
      },

      onHeaderSearch: function () {
        MessageToast.show("Search is not available yet.");
      },

      onHeaderNotifications: function () {
        MessageToast.show("No new notifications.");
      },

      onTabSelect: function (oEvent) {
        var sKey = oEvent.getParameter("key");
        this._showTab(sKey);
      },

      onFullScreen: function () {
        MessageToast.show("Full screen is not available in this view.");
      },

      onRefresh: function () {
        this.onSearch();
      },

      onToggleVendorsTab: function () {
        this._showTab("vendors");
      },

      onCloseCard: function () {
        this._oReconModel.setData({
          items: [],
          donut: [],
          count: 0,
          busy: false,
        });
      },

      /**
       * Budat filter for the active search: an EQ on the From Date when no
       * To Date was entered, or a BT range when both dates are set.
       */
      _getBudatFilter: function (sPath) {
        if (this._sKeyDateTo) {
          return new Filter(
            sPath,
            FilterOperator.BT,
            new Date(this._sKeyDate),
            new Date(this._sKeyDateTo),
          );
        }
        return new Filter(sPath, FilterOperator.EQ, new Date(this._sKeyDate));
      },

      /**
       * Compact Indian-unit label used in the Top Categories list so large
       * figures (Crores) fit the narrow panel instead of overflowing it.
       */
      /**
       * Truncates (never rounds) fNum to 2 decimal places â€" e.g. 5.9369690
       * -> 5.93, not the 5.94 Math.round-style rounding would give. Shared
       * by formatLakh/formatSidebarAmount so a Crore/Lakh figure never
       * shows a value a paisa higher than what actually adds up.
       */
      _truncate2: function (fNum) {
        return Math.floor(fNum * 100) / 100;
      },

      formatLakh: function (fValue) {
        var fNum = parseFloat(fValue) || 0;
        var sSign = fNum < 0 ? "-" : "";
        var fAbs = Math.abs(fNum);

        if (fAbs >= 1e7) {
          return (
            sSign +
            this._truncate2(fAbs / 1e7).toLocaleString("en-IN", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            }) +
            " Cr"
          );
        }
        if (fAbs >= 1e5) {
          return (
            sSign +
            this._truncate2(fAbs / 1e5).toLocaleString("en-IN", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            }) +
            " L"
          );
        }
        return (
          sSign +
          this._truncate2(fAbs).toLocaleString("en-IN", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })
        );
      },

      /**
       * Compact "â‚¹<n> Cr/L/K" amount used for the Finance (FI) sidebar rows â€"
       * these sit in a narrow column next to the row label, so the full
       * formatBalanceValue figure (e.g. "â‚¹45,24,42,936") wraps/overflows;
       * this collapses it to Crore/Lakh/Thousand the same way formatLakh
       * already does for the Top Categories list, just with a â‚¹ prefix and
       * an extra "K" tier for values under a lakh.
       */
      formatSidebarAmount: function (fValue) {
        var fNum = parseFloat(fValue) || 0;
        var sSign = fNum < 0 ? "-" : "";
        var fAbs = Math.abs(fNum);

        if (fAbs >= 1e7) {
          return (

            sSign +
            this._truncate2(fAbs / 1e7).toLocaleString("en-IN", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            }) +
            " Cr"
          );
        }
        if (fAbs >= 1e5) {
          return (

            sSign +
            this._truncate2(fAbs / 1e5).toLocaleString("en-IN", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            }) +
            " L"
          );
        }
        if (fAbs >= 1e3) {
          return (

            sSign +
            this._truncate2(fAbs / 1e3).toLocaleString("en-IN", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            }) +
            " K"
          );
        }
        return (
         sSign + fAbs.toLocaleString("en-IN", { maximumFractionDigits: 0 })
        );
      },

      formatCategory: function (sTxt) {
        if (!sTxt) return "";
        var i = sTxt.indexOf("-");
        return i > -1 ? sTxt.substring(i + 1).trim() : sTxt;
      },

      /** Whole-rupee currency string for the master-detail "Balance value" tile. */
      formatBalanceValue: function (fValue) {
        var fNum = parseFloat(fValue) || 0;
        var sSign = fNum < 0 ? "-" : "";
        return (
          
          sSign +
          Math.abs(fNum).toLocaleString("en-IN", { maximumFractionDigits: 0 })
        );
      },

      formatAmount: function (fValue) {
        var fNum = parseFloat(fValue) || 0;
        return fNum.toLocaleString("en-IN", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
      },

      /**
       * "Total quantity: <n>" label used in place of the vendor-name
       * subtitle on Total PO value/Pending PO's identity tile â€" the
       * vendor name is already visible in the top filter bar's Supplier
       * field, so every panel drops it; these two panels show a summed
       * item quantity there instead (Total PO's Menge / Pending PO's
       * PendQty), same number formatting as formatAmount.
       */
      formatQtyLabel: function (fValue) {
        return "Total Quantity: " + this.formatAmount(fValue);
      },

      /**
       * Value column on the Share of Business panel. Menge/Netwr/TotalQty/
       * TotalAmt (Raw=false) get the usual thousands-separator formatting;
       * SobMenge/SobNetwr (Raw=true, the % share fields) are shown exactly
       * as the backend returned them, no rounding.
       */
      formatShareOfBusinessValue: function (vValue, bRaw) {
        if (bRaw) {
          return vValue == null ? "" : String(vValue);
        }
        return this.formatAmount(vValue);
      },

      /** "Share of Business" row value in the left sidebar — e.g. "3.656%". */
      formatShareOfBusinessSidebarValue: function (sPercent) {
        return sPercent ? sPercent + "%" : "";
      },

      /**
       * Quantity/Total Qty stat boxes on the Share of Business panel â€"
       * ShareLifnrSet's Menge/TotalQty come back in KG, way too many
       * digits to read at a glance (e.g. 6220530), so show metric tons
       * instead (÷1000) with an "MT" suffix, same rounding as formatAmount.
       */
      formatShareOfBusinessQtyTons: function (fValue) {
        var fNum = parseFloat(fValue) || 0;
        return this.formatAmount(fNum / 1000) + " MT";
      },

      /**
       * Value/Total Amount stat boxes on the Share of Business panel â€"
       * shown in crores (Ã·1e7) with a "Cr" suffix instead of the exact
       * rupee figure, same scale as the sidebar's Total PO Value/Payments
       * rows (see formatSidebarAmount).
       */
      formatShareOfBusinessValueCrores: function (fValue) {
        var fNum = parseFloat(fValue) || 0;
        return this.formatAmount(fNum / 1e7) + " Cr";
      },

      /**
       * Total Qty Breakdown table (Share of Business) — Share of Qty %/
       * Share of Value % columns: green when the supplier's share is >=
       * 100%, red when under. XML expression binding directly on "class"
       * wasn't taking effect, so this goes through a plain formatter like
       * every other conditional class in this app.
       */
      formatShareClass: function (vValue) {
        var fNum = parseFloat(vValue) || 0;
        return fNum >= 100 ? "mdSobShareGreen" : "mdSobShareRed";
      },

      formatInvoiceFooter: function (fValue) {
        return "Invoice Amt: " + this.formatAmount(fValue);
      },

      /** Converts a "yyyy-MM-dd" DatePicker value into "dd.MM.yyyy" for display. */
      formatDisplayDate: function (sValue) {
        if (!sValue) return "";
        var oDate = new Date(sValue);
        if (isNaN(oDate.getTime())) return sValue;
        var sDay = String(oDate.getDate()).padStart(2, "0");
        var sMonth = String(oDate.getMonth() + 1).padStart(2, "0");
        return sDay + "." + sMonth + "." + oDate.getFullYear();
      },

      /** Formats an OData Edm.DateTime value (OpenItemsSet Budat) as "dd.MM.yyyy". */
      formatOpenItemDate: function (oValue) {
        if (!oValue) return "";
        var oDate = oValue instanceof Date ? oValue : new Date(oValue);
        if (isNaN(oDate.getTime())) return "";
        var sDay = String(oDate.getDate()).padStart(2, "0");
        var sMonth = String(oDate.getMonth() + 1).padStart(2, "0");
        return sDay + "." + sMonth + "." + oDate.getFullYear();
      },

      /** OpenItemsSet rows with no clearing document (Augbl) are still open. */
      formatOpenItemStatus: function (sAugbl) {
        return sAugbl && String(sAugbl).trim() ? "Cleared" : "Open";
      },

      formatOpenItemStatusState: function (sAugbl) {
        return sAugbl && String(sAugbl).trim() ? "Success" : "Warning";
      },

      /**
       * Abbreviates a large amount for display inside a NumericContent tile
       * (e.g. GenericTile), whose numeric field is too narrow for full
       * comma-formatted figures â€" and mis-truncates value strings that mix
       * digits with letters. Split the number and its Indian-unit suffix
       * (Cr / L / K) so the number goes in "value" and the suffix in the
       * dedicated "scale" property instead.
       */
      formatCompactAmount: function (fValue) {
        var fNum = parseFloat(fValue) || 0;
        var sSign = fNum < 0 ? "-" : "";
        var fAbs = Math.abs(fNum);
        var fScaled = fAbs;

        if (fAbs >= 1e7) {
          fScaled = fAbs / 1e7;
        } else if (fAbs >= 1e5) {
          fScaled = fAbs / 1e5;
        } else if (fAbs >= 1e3) {
          fScaled = fAbs / 1e3;
        }

        // NumericContent silently hard-clips its value text to 4 characters
        // total (sign included) â€" pick the most decimals that still fit
        // that budget instead of letting it truncate mid-number.
        var iBudget = 4 - sSign.length;
        var iIntDigits = Math.max(1, Math.floor(fScaled).toString().length);
        var iDecimals = 0;
        if (iIntDigits + 1 + 2 <= iBudget) {
          iDecimals = 2;
        } else if (iIntDigits + 1 + 1 <= iBudget) {
          iDecimals = 1;
        }
        return sSign + fScaled.toFixed(iDecimals);
      },

      formatCompactScale: function (fValue) {
        var fAbs = Math.abs(parseFloat(fValue) || 0);
        if (fAbs >= 1e7) return "Cr";
        if (fAbs >= 1e5) return "L";
        if (fAbs >= 1e3) return "K";
        return "";
      },

      formatValueColor: function (fValue) {
        var fNum = parseFloat(fValue) || 0;
        return fNum < 0 ? "Error" : "Good";
      },

      /** ValueState (for ObjectNumber/ObjectStatus "state") variant of formatValueColor. */
      formatValueState: function (fValue) {
        var fNum = parseFloat(fValue) || 0;
        return fNum < 0 ? "Error" : "Success";
      },

      formatIndicator: function (fValue) {
        var fNum = parseFloat(fValue) || 0;
        return fNum < 0 ? "Down" : "Up";
      },

      onDonutHtmlRendered: function () {
        this._renderDonutSvg(0);
      },

      onMdBarChartHtmlRendered: function () {
        this._renderMonthlyBarChart(0);
      },

      onMdPaymentsBarChartHtmlRendered: function () {
        this._renderPaymentsTypeBarChart(0);
      },

      onMdTotalPOBarChartHtmlRendered: function () {
        this._renderTotalPOTypeBarChart(0);
      },

      /** afterRendering hook for the Pending PO panel's bar chart tile — see _renderPendingPOTypeBarChart. */
      onMdPendingPOBarChartHtmlRendered: function () {
        this._renderPendingPOTypeBarChart(0);
      },

      /** afterRendering hook for the Lots received panel's bar chart tile â€" see _renderLotsReceivedTypeBarChart. */
      onMdLotsReceivedBarChartHtmlRendered: function () {
        this._renderLotsReceivedTypeBarChart(0);
      },

      /**
       * Draws the "Normal / Open item / Partial payment" chart that sits
       * as its own tile inside the Payments panel's stat-tiles row
       * (mdStatTilesRow) â€" one horizontal bar per category
       * (.mdHBarRow/.mdHBar/.mdHBarTrack), sourced from
       * /paymentsTypeTotals (same 3 fixed categories every time).
       * Clicking a bar filters the Payments table below down to that
       * category (toggle-to-clear, same as the monthly chart's month
       * bars) â€" see _onPaymentsCategorySelected.
       */
      _renderPaymentsTypeBarChart: function (iAttempt) {
        var that = this;
        iAttempt = iAttempt || 0;

        var oContainer = document.getElementById(
          "mdPaymentsBarChartContainer",
        );
        if (!oContainer) {
          if (iAttempt < 10) {
            setTimeout(function () {
              that._renderPaymentsTypeBarChart(iAttempt + 1);
            }, 100);
          }
          return;
        }

        var oReconModel = this.getView().getModel("recon");
        var aTypeTotals = oReconModel.getProperty("/paymentsTypeTotals") || [];
        var sSelectedKey = oReconModel.getProperty(
          "/mdPaymentsSelectedCategory",
        );

        if (!aTypeTotals.length) {
          oContainer.innerHTML = "";
          return;
        }

        var MIN_W = 4,
          MAX_W = 100; // percent of the track's width
        var fMaxAbs =
          aTypeTotals.reduce(function (fMax, o) {
            return Math.max(fMax, Math.abs(o.amount));
          }, 0) || 1;

        var sHtml = "";
        aTypeTotals.forEach(function (o) {
          var fWidthPct =
            o.amount === 0
              ? MIN_W
              : MIN_W + (Math.abs(o.amount) / fMaxAbs) * (MAX_W - MIN_W);
          var bNegative = o.amount < 0;
          var bActive = sSelectedKey === o.key;
          sHtml +=
            '<div class="mdHBarRow' +
            (bActive ? " mdHBarRowActive" : "") +
            '" data-category-key="' +
            o.key +
            '">' +
            '<span class="mdHBarLabel">' +
            o.label +
            "</span>" +
            '<div class="mdHBarTrack">' +
            '<div class="mdHBar' +
            (bNegative ? " mdBarNegative" : "") +
            (bActive ? " mdHBarActive" : "") +
            '" style="width:' +
            fWidthPct.toFixed(1) +
            '%" title="' +
            o.label +
            ": " +
            that.formatAmount(o.amount) +
            '"></div>' +
            "</div>" +
            '<span class="mdHBarValue">' +
            that.formatLakh(o.amount) +
            "</span>" +
            "</div>";
        });

        oContainer.innerHTML = sHtml;

        oContainer.querySelectorAll(".mdHBarRow").forEach(function (oRowEl) {
          oRowEl.addEventListener("click", function () {
            that._onPaymentsCategorySelected(
              oRowEl.getAttribute("data-category-key"),
            );
          });
        });
      },

      /**
       * Draws the "PO / Contract" chart that sits as its own tile inside
       * the Total PO value panel's stat-tiles row (mdStatTilesRow) â€" one
       * horizontal bar per PO document category (.mdHBarRow/.mdHBar/
       * .mdHBarTrack), sourced from /totalPOTypeTotals which splits
       * TotalPOSet's rows by Bstyp: "F" is a PO, "K" is a Contract (same
       * split-by-Bstyp rule everywhere else Bstyp is read). Same markup/
       * CSS as _renderPaymentsTypeBarChart, and same click-to-filter â€"
       * see _onTotalPOCategorySelected.
       */
      _renderTotalPOTypeBarChart: function (iAttempt) {
        var that = this;
        iAttempt = iAttempt || 0;

        var oContainer = document.getElementById(
          "mdTotalPOBarChartContainer",
        );
        if (!oContainer) {
          if (iAttempt < 10) {
            setTimeout(function () {
              that._renderTotalPOTypeBarChart(iAttempt + 1);
            }, 100);
          }
          return;
        }

        var oReconModel = this.getView().getModel("recon");
        var aTypeTotals = oReconModel.getProperty("/totalPOTypeTotals") || [];
        var sSelectedKey = oReconModel.getProperty(
          "/mdTotalPOSelectedCategory",
        );

        if (!aTypeTotals.length) {
          oContainer.innerHTML = "";
          return;
        }

        var MIN_W = 4,
          MAX_W = 100; // percent of the track's width
        var fMaxAbs =
          aTypeTotals.reduce(function (fMax, o) {
            return Math.max(fMax, Math.abs(o.amount));
          }, 0) || 1;

        var sHtml = "";
        aTypeTotals.forEach(function (o) {
          var fWidthPct =
            o.amount === 0
              ? MIN_W
              : MIN_W + (Math.abs(o.amount) / fMaxAbs) * (MAX_W - MIN_W);
          var bNegative = o.amount < 0;
          var bActive = sSelectedKey === o.key;
          sHtml +=
            '<div class="mdHBarRow' +
            (bActive ? " mdHBarRowActive" : "") +
            '" data-category-key="' +
            o.key +
            '">' +
            '<span class="mdHBarLabel">' +
            o.label +
            "</span>" +
            '<div class="mdHBarTrack">' +
            '<div class="mdHBar' +
            (bNegative ? " mdBarNegative" : "") +
            (bActive ? " mdHBarActive" : "") +
            '" style="width:' +
            fWidthPct.toFixed(1) +
            '%" title="' +
            o.label +
            ": " +
            that.formatAmount(o.amount) +
            '"></div>' +
            "</div>" +
            '<span class="mdHBarValue">' +
            that.formatLakh(o.amount) +
            "</span>" +
            "</div>";
        });

        oContainer.innerHTML = sHtml;

        oContainer.querySelectorAll(".mdHBarRow").forEach(function (oRowEl) {
          oRowEl.addEventListener("click", function () {
            that._onTotalPOCategorySelected(
              oRowEl.getAttribute("data-category-key"),
            );
          });
        });
      },

      /**
       * Fired when a bar in the Total PO value "PO / Contract" chart is
       * clicked. Filters /totalPOItems (bound to the Total PO table) down
       * to the rows in that Bstyp bucket â€" same toggle-to-clear behaviour
       * as the Payments chart: clicking the already-active bar clears the
       * filter back to the full list. See _onPaymentsCategorySelected.
       * Also recomputes /totalPOTotal ("Total PO amount") and /totalPOQty
       * ("Total quantity") from whichever set is now showing â€" those two
       * stat tiles used to keep showing the grand total regardless of
       * which bar was clicked, since only the table (/totalPOItems, whose
       * own .length already drives "Total PO items" reactively) was being
       * filtered.
       */
      _onTotalPOCategorySelected: function (sCategoryKey) {
        var oReconModel = this._oReconModel;
        var sCurrent = oReconModel.getProperty("/mdTotalPOSelectedCategory");
        oReconModel.setProperty(
          "/mdTotalPOSelectedCategory",
          sCurrent === sCategoryKey ? null : sCategoryKey,
        );
        this._applyTotalPOFilters();
      },

      /**
       * Recomputes /totalPOItems (bound to the Total PO table) from
       * /totalPOItemsAll by combining BOTH active Total PO filters â€" the
       * PO/Contract bar-chart category (/mdTotalPOSelectedCategory, see
       * _onTotalPOCategorySelected) and the Material checkbox filter
       * (/totalPOSelectedMaterials, see onTotalPOMaterialFilterChange) â€"
       * so picking one doesn't silently drop the other. Also recomputes
       * /totalPOTotal ("Total PO amount") and /totalPOQty ("Total
       * quantity") from whichever rows are now showing, same as
       * _onTotalPOCategorySelected always did on its own.
       */
      _applyTotalPOFilters: function () {
        var oReconModel = this._oReconModel;
        var aAll = oReconModel.getProperty("/totalPOItemsAll") || [];
        var sCategoryKey = oReconModel.getProperty("/mdTotalPOSelectedCategory");
        var aSelectedMaterials =
          oReconModel.getProperty("/totalPOSelectedMaterials") || [];

        var aShown = aAll.filter(function (o) {
          if (sCategoryKey) {
            var bIsContract = o.Bstyp === "K";
            if (sCategoryKey === "K" ? !bIsContract : bIsContract) {
              return false;
            }
          }
          if (aSelectedMaterials.length > 0) {
            return aSelectedMaterials.indexOf(o.Matnr) > -1;
          }
          return true;
        });

        oReconModel.setProperty("/totalPOItems", aShown);
        oReconModel.setProperty(
          "/totalPOTotal",
          aShown.reduce(function (fSum, o) {
            return fSum + (parseFloat(o.Netwr) || 0);
          }, 0),
        );
        oReconModel.setProperty(
          "/totalPOQty",
          aShown.reduce(function (fSum, o) {
            return fSum + (parseFloat(o.Menge) || 0);
          }, 0),
        );

        this._renderTotalPOTypeBarChart(0);
      },

      /**
       * Opens the multi-select Material filter popover for the Total PO
       * table (the "Filter" button next to Column Settings/Select Layout
       * on TotalPOPanel.fragment.xml), populated from /totalPOMaterialOptions
       * (every distinct Material actually present in the current Total PO
       * read â€" see onTotalPOPress) rather than a fixed value list, since
       * which materials exist varies per supplier/date range.
       */
      onTotalPOMaterialFilterPress: function (oEvent) {
        var oView = this.getView();
        var oButton = oEvent.getSource();
        var oReconModel = this._oReconModel;
        var aOptions = oReconModel.getProperty("/totalPOMaterialOptions") || [];
        var aSelected = oReconModel.getProperty("/totalPOSelectedMaterials") || [];

        oView.setModel(
          new JSONModel({
            values: aOptions.map(function (o) {
              return {
                key: o.key,
                text: o.text,
                selected: aSelected.indexOf(o.key) > -1,
              };
            }),
          }),
          "totalPOMaterialFilterModel",
        );

        var that = this;
        if (!this._oTotalPOMaterialFilterPopover) {
          Fragment.load({
            id: oView.getId(),
            name: "supplieropenitems.view.fragment.TotalPOMaterialFilterPopover",
            controller: this,
          }).then(function (oPopover) {
            that._oTotalPOMaterialFilterPopover = oPopover;
            oView.addDependent(oPopover);
            oPopover.openBy(oButton);
          });
        } else {
          this._oTotalPOMaterialFilterPopover.openBy(oButton);
        }
      },

      /** Ticked/unticked in the Material filter popover's checkbox list â€" applied immediately, same live-filter feel as the PO/Contract chart bars. */
      onTotalPOMaterialFilterChange: function () {
        var oList = this.byId("totalPOMaterialFilterList");
        if (!oList) return;

        var aSelectedKeys = oList.getSelectedItems().map(function (oItem) {
          return oItem
            .getBindingContext("totalPOMaterialFilterModel")
            .getProperty("key");
        });
        this._oReconModel.setProperty("/totalPOSelectedMaterials", aSelectedKeys);
        this._applyTotalPOFilters();
      },

      /** "Clear" in the Material filter popover â€" back to every material shown. */
      onTotalPOMaterialFilterClear: function () {
        var oList = this.byId("totalPOMaterialFilterList");
        if (oList) {
          oList.removeSelections(true);
        }
        this._oReconModel.setProperty("/totalPOSelectedMaterials", []);
        this._applyTotalPOFilters();
      },

      /**
       * Draws the "PO / Contract" chart that sits as its own tile inside
       * the Pending PO panel's stat-tiles row (mdStatTilesRow) — one
       * horizontal bar per document category (.mdHBarRow/.mdHBar/
       * .mdHBarTrack), sourced from /pendingPOTypeTotals which splits
       * pendingpoSet's rows by Bstyp: "F" is a PO, "K" is a Contract (same
       * split-by-Bstyp rule as Total PO value). Same markup/CSS as
       * _renderTotalPOTypeBarChart, and same click-to-filter — see
       * _onPendingPOCategorySelected.
       */
      _renderPendingPOTypeBarChart: function (iAttempt) {
        var that = this;
        iAttempt = iAttempt || 0;

        var oContainer = document.getElementById(
          "mdPendingPOBarChartContainer",
        );
        if (!oContainer) {
          if (iAttempt < 10) {
            setTimeout(function () {
              that._renderPendingPOTypeBarChart(iAttempt + 1);
            }, 100);
          }
          return;
        }

        var oReconModel = this.getView().getModel("recon");
        var aTypeTotals =
          oReconModel.getProperty("/pendingPOTypeTotals") || [];
        var sSelectedKey = oReconModel.getProperty(
          "/mdPendingPOSelectedCategory",
        );

        if (!aTypeTotals.length) {
          oContainer.innerHTML = "";
          return;
        }

        var MIN_W = 4,
          MAX_W = 100; // percent of the track's width
        var fMaxAbs =
          aTypeTotals.reduce(function (fMax, o) {
            return Math.max(fMax, Math.abs(o.amount));
          }, 0) || 1;

        var sHtml = "";
        aTypeTotals.forEach(function (o) {
          var fWidthPct =
            o.amount === 0
              ? MIN_W
              : MIN_W + (Math.abs(o.amount) / fMaxAbs) * (MAX_W - MIN_W);
          var bNegative = o.amount < 0;
          var bActive = sSelectedKey === o.key;
          sHtml +=
            '<div class="mdHBarRow' +
            (bActive ? " mdHBarRowActive" : "") +
            '" data-category-key="' +
            o.key +
            '">' +
            '<span class="mdHBarLabel">' +
            o.label +
            "</span>" +
            '<div class="mdHBarTrack">' +
            '<div class="mdHBar' +
            (bNegative ? " mdBarNegative" : "") +
            (bActive ? " mdHBarActive" : "") +
            '" style="width:' +
            fWidthPct.toFixed(1) +
            '%" title="' +
            o.label +
            ": " +
            that.formatAmount(o.amount) +
            '"></div>' +
            "</div>" +
            '<span class="mdHBarValue">' +
            that.formatLakh(o.amount) +
            "</span>" +
            "</div>";
        });

        oContainer.innerHTML = sHtml;

        oContainer.querySelectorAll(".mdHBarRow").forEach(function (oRowEl) {
          oRowEl.addEventListener("click", function () {
            that._onPendingPOCategorySelected(
              oRowEl.getAttribute("data-category-key"),
            );
          });
        });
      },

      /**
       * Fired when a bar in the Pending PO "PO / Contract" chart is
       * clicked. Filters /pendingPOItems (bound to the Pending PO table)
       * down to the rows in that Bstyp bucket — same toggle-to-clear
       * behaviour as the Total PO value chart: clicking the already-active
       * bar clears the filter back to the full list. Also recomputes
       * /pendingPOTotal ("Total Pending PO Amount") and /pendingPOQty
       * ("Pending PO" quantity label) from whichever set is now showing —
       * same reasoning as _onTotalPOCategorySelected.
       */
      _onPendingPOCategorySelected: function (sCategoryKey) {
        var oReconModel = this._oReconModel;
        var sCurrent = oReconModel.getProperty(
          "/mdPendingPOSelectedCategory",
        );
        var aAll = oReconModel.getProperty("/pendingPOItemsAll") || [];
        var aShown;

        if (sCurrent === sCategoryKey) {
          oReconModel.setProperty("/mdPendingPOSelectedCategory", null);
          aShown = aAll;
        } else {
          aShown = aAll.filter(function (o) {
            return sCategoryKey === "K"
              ? o.Bstyp === "K"
              : o.Bstyp !== "K";
          });
          oReconModel.setProperty(
            "/mdPendingPOSelectedCategory",
            sCategoryKey,
          );
        }

        oReconModel.setProperty("/pendingPOItems", aShown);
        oReconModel.setProperty(
          "/pendingPOTotal",
          aShown.reduce(function (fSum, o) {
            return fSum + (parseFloat(o.PendVal) || 0);
          }, 0),
        );
        oReconModel.setProperty(
          "/pendingPOQty",
          aShown.reduce(function (fSum, o) {
            return fSum + (parseFloat(o.PendQty) || 0);
          }, 0),
        );

        this._renderPendingPOTypeBarChart(0);
      },

      /**
       * Draws the vertical bar chart that sits full-width below the Lots
       * received panel's stat-tiles row â€" one column per code in the fixed
       * LOTS_RECEIVED_CODES list (.mdBarCol/.mdBar/.mdBarValue/
       * .mdBarLabel), sourced from /lotsReceivedTypeTotals which counts
       * LotRecSet's rows by Vcode â€" number of lots, not summed quantity.
       * A/A1-A5 bars are blue, R/R1-R3 bars are red (.mdBarNegative â€" same
       * red used for a negative balance elsewhere). Same click-to-filter
       * as the Opening balance panel's "Last 12 Months Balance" chart (see
       * _renderMonthlyBarChart), just keyed by usage-decision code instead
       * of calendar month.
       */
      _renderLotsReceivedTypeBarChart: function (iAttempt) {
        var that = this;
        iAttempt = iAttempt || 0;

        var oContainer = document.getElementById(
          "mdLotsReceivedBarChartContainer",
        );
        if (!oContainer) {
          if (iAttempt < 10) {
            setTimeout(function () {
              that._renderLotsReceivedTypeBarChart(iAttempt + 1);
            }, 100);
          }
          return;
        }

        var oReconModel = this.getView().getModel("recon");
        var aTypeTotals = oReconModel.getProperty("/lotsReceivedTypeTotals") || [];
        var sSelectedKey = oReconModel.getProperty(
          "/mdLotsReceivedSelectedCategory",
        );

        if (!aTypeTotals.length) {
          oContainer.innerHTML = "";
          return;
        }

        var MIN_H = 1.8,
          MAX_H = 3.4; // rem, same scale as _renderMonthlyBarChart
        var fMaxAbs =
          aTypeTotals.reduce(function (fMax, o) {
            return Math.max(fMax, Math.abs(o.amount));
          }, 0) || 1;

        var sHtml = "";
        aTypeTotals.forEach(function (o) {
          var fHeight =
            o.amount === 0
              ? MIN_H
              : MIN_H + (Math.abs(o.amount) / fMaxAbs) * (MAX_H - MIN_H);
          // "Rejected"-style codes (R/R1/R2/R3) always draw red, regardless
          // of count. "A" and "A4" draw green; the remaining accepted-style
          // codes (A1/A2/A3/A5) stay the default blue. Zero-count bars
          // still get their group's color (a sliver height), not the muted
          // mdBarEmpty grey.
          var bNegative = o.key.charAt(0) === "R";
          var bPositive = o.key === "A" || o.key === "A4";
          var bActive = sSelectedKey === o.key;
          sHtml +=
            '<div class="mdBarCol">' +
            '<div class="mdBar' +
            (bActive ? " mdBarActive" : "") +
            (bNegative ? " mdBarNegative" : "") +
            (bPositive ? " mdBarPositive" : "") +
            '" style="height:' +
            fHeight.toFixed(2) +
            'rem" data-category-key="' +
            o.key +
            '" title="' +
            o.label +
            ": " +
            o.amount +
            (o.amount === 1 ? " lot" : " lots") +
            '"></div>' +
            '<span class="mdBarValue">' +
            o.amount +
            "</span>" +
            '<span class="mdBarLabel">' +
            o.label +
            "</span>" +
            "</div>";
        });

        oContainer.innerHTML = sHtml;

        oContainer.querySelectorAll(".mdBar").forEach(function (oBarEl) {
          oBarEl.addEventListener("click", function () {
            that._onLotsReceivedCategorySelected(
              oBarEl.getAttribute("data-category-key"),
            );
          });
        });
      },

      /**
       * Fired when a bar in the Lots received by-Vcode chart (fixed
       * A/A1-A5/R/R1-R3 set â€" see LOTS_RECEIVED_CODES) is clicked. Filters
       * /lotsReceivedItems (bound to the Lots received table) down to the
       * rows with that Vcode. Same toggle-to-clear behaviour as the AUD
       * qty chart: clicking the already-active bar clears the filter back
       * to the full list. See _onAudQtyCategorySelected. Also recomputes
       * /lotsReceivedTotal ("Total received qty") from whichever set is
       * now showing â€" "Total lots received" already reads
       * /lotsReceivedItems.length directly so it updates on its own, but
       * the qty total was a separately-stored figure that used to keep
       * showing the grand total regardless of which bar was clicked.
       */
      _onLotsReceivedCategorySelected: function (sCategoryKey) {
        var oReconModel = this._oReconModel;
        var sCurrent = oReconModel.getProperty(
          "/mdLotsReceivedSelectedCategory",
        );
        var aAll = oReconModel.getProperty("/lotsReceivedItemsAll") || [];
        var aShown;

        if (sCurrent === sCategoryKey) {
          oReconModel.setProperty("/mdLotsReceivedSelectedCategory", null);
          aShown = aAll;
        } else {
          aShown = aAll.filter(function (o) {
            return o.Vcode === sCategoryKey;
          });
          oReconModel.setProperty(
            "/mdLotsReceivedSelectedCategory",
            sCategoryKey,
          );
        }

        oReconModel.setProperty("/lotsReceivedItems", aShown);
        oReconModel.setProperty(
          "/lotsReceivedTotal",
          aShown.reduce(function (fSum, o) {
            return fSum + (parseFloat(o.Losmenge) || 0);
          }, 0),
        );

        this._renderLotsReceivedTypeBarChart(0);
      },

      /**
       * Refresh button in the master-detail header: re-runs the current
       * Company Code/Supplier/date-range search, which reloads
       * OpenItemsSet from scratch and â€" via _loadSupplierMasterDetail â€"
       * resets the month filter, bar chart and line items back to the
       * full, unfiltered result (same as a fresh Supplier search).
       */
      onRefreshMasterDetail: function () {
        var sLifnr = this._oReconModel.getProperty("/mdLifnr");
        if (!this._sBukrs || !sLifnr || !this._sKeyDate) return;
        this._loadSupplierMasterDetail(
          this._sBukrs,
          sLifnr,
          this._sKeyDate,
          this._sKeyDateTo,
        );
      },

      /**
       * Draws the "Balance movement" bar chart from every distinct posting
       * month present in the master-detail's full OpenItemsSet result
       * (/openItemsAll â€" unfiltered by any month click), oldest to newest.
       * Clicking a bar filters the "Line items" table below (/openItems)
       * down to just that month, matched back against /openItemsAll.
       */
      _renderMonthlyBarChart: function (iAttempt) {
        var that = this;
        iAttempt = iAttempt || 0;

        var oContainer = document.getElementById("mdBarChartContainer");
        if (!oContainer) {
          if (iAttempt < 10) {
            setTimeout(function () {
              that._renderMonthlyBarChart(iAttempt + 1);
            }, 100);
          }
          return;
        }

        var oReconModel = this.getView().getModel("recon");
        var bTransactions = oReconModel.getProperty("/mdShowTransactions");

        var aMonthly;
        if (bTransactions) {
          // Transactions panel: span every calendar month between the
          // searched From Date and To Date (defaulting To Date to From
          // Date when none was entered), using the transactionperiodSet
          // result instead of the fixed 12-month Opening balance window.
          var aTransactionsAll = oReconModel.getProperty("/transactionsAll") || [];
          aMonthly = this._computeMonthsRangeTotals(
            aTransactionsAll,
            this._sKeyDate,
            this._sKeyDateTo || this._sKeyDate,
          );
        } else {
          var aOpenItemsAll = oReconModel.getProperty("/openItemsAll") || [];

          // Always exactly 12 fixed calendar months, ending at the searched
          // To Date (falling back to From Date when no To Date was
          // entered) â€" e.g. To Date = 28.02.2025 draws Mar 2024 through
          // Feb 2025. Months with no postings still get their own bar (a
          // flat/zero one) instead of being skipped, so the chart is always
          // a consistent 12-month strip.
          aMonthly = this._computeLastTwelveMonthsTotals(
            aOpenItemsAll,
            this._sKeyDateTo || this._sKeyDate,
          );
        }

        oReconModel.setProperty(
          "/mdBarChartRangeLabel",
          aMonthly.length
            ? aMonthly[0].label +
                (aMonthly.length > 1
                  ? " - " + aMonthly[aMonthly.length - 1].label
                  : "")
            : "no data",
        );

        if (!aMonthly.length) {
          oContainer.innerHTML = "";
          this._updateVsPriorPeriod(aMonthly, null);
          return;
        }

        var sSelectedLabel = oReconModel.getProperty(
          "/mdSelectedMonthLabel",
        );
        var iSelectedKey = null;
        if (sSelectedLabel) {
          var oSelectedMonth = aMonthly.filter(function (o) {
            return o.label === sSelectedLabel;
          })[0];
          iSelectedKey = oSelectedMonth ? oSelectedMonth.sortKey : null;
        }
        this._updateVsPriorPeriod(aMonthly, iSelectedKey);
        var MIN_H = 1.8,
          MAX_H = 3.4,
          ZERO_H = 0.12; // flat sliver for months with no postings at all
        var fMaxAbs =
          aMonthly.reduce(function (fMax, o) {
            return Math.max(fMax, o.absNetAmt);
          }, 0) || 1;

        var sHtml = "";
        aMonthly.forEach(function (o) {
          var fHeight = o.hasData
            ? MIN_H + (o.absNetAmt / fMaxAbs) * (MAX_H - MIN_H)
            : ZERO_H;
          var bActive = sSelectedLabel
            ? o.label === sSelectedLabel
            : o.sortKey === aMonthly[aMonthly.length - 1].sortKey;
          var bNegative = o.hasData && o.netAmt < 0;
          sHtml +=
            '<div class="mdBarCol">' +
            '<div class="mdBar' +
            (bActive ? " mdBarActive" : "") +
            (o.hasData ? "" : " mdBarEmpty") +
            (bNegative ? " mdBarNegative" : "") +
            '" style="height:' +
            fHeight.toFixed(2) +
            'rem" data-month-key="' +
            o.sortKey +
            '" title="' +
            o.label +
            ": " +
            (o.hasData ? that.formatAmount(o.netAmt) : "No data") +
            '"></div>' +
            '<span class="mdBarValue">' +
            (o.hasData ? that.formatLakh(o.netAmt) : "—") +
            "</span>" +
            '<span class="mdBarLabel">' +
            o.label +
            "</span>" +
            "</div>";
        });

        oContainer.innerHTML = sHtml;

        oContainer.querySelectorAll(".mdBar").forEach(function (oBarEl) {
          oBarEl.addEventListener("click", function () {
            var iMonthKey = parseInt(
              oBarEl.getAttribute("data-month-key"),
              10,
            );
            that._onMonthSelected(iMonthKey);
          });
        });
      },

      /**
       * Filters /openItems (bound to the Line items table) down to the
       * open items whose posting month matches iMonthKey, and re-renders
       * the bar chart so the clicked bar highlights.
       */
      _onMonthSelected: function (iMonthKey) {
        var oReconModel = this._oReconModel;
        var bTransactions = oReconModel.getProperty("/mdShowTransactions");
        var sSourcePath = bTransactions ? "/transactionsAll" : "/openItemsAll";
        var aAll = oReconModel.getProperty(sSourcePath) || [];

        var aFiltered = aAll.filter(function (o) {
          if (!o.Budat) return false;
          var oDate = o.Budat instanceof Date ? o.Budat : new Date(o.Budat);
          if (isNaN(oDate.getTime())) return false;
          return oDate.getFullYear() * 12 + oDate.getMonth() === iMonthKey;
        });

        var oMonthDate = new Date(
          Math.floor(iMonthKey / 12),
          ((iMonthKey % 12) + 12) % 12,
          1,
        );
        var sLabel = oMonthDate.toLocaleString("en-US", {
          month: "short",
          year: "numeric",
        });

        if (bTransactions) {
          oReconModel.setProperty("/transactionItems", aFiltered);
          oReconModel.setProperty("/mdSelectedMonthLabel", sLabel);
          this._renderMonthlyBarChart(0);
          return;
        }

        oReconModel.setProperty("/openItems", aFiltered);
        oReconModel.setProperty("/openItemsTotal", this._sumNetAmt(aFiltered));
        oReconModel.setProperty("/mdSelectedMonthLabel", sLabel);
        this._renderMonthlyBarChart(0);
      },

      /**
       * Builds exactly 6 fixed calendar-month buckets ending at sAnchorDate
       * (the searched "From Date") â€" e.g. anchor 28.02.2025 gives Sep 2024,
       * Oct 2024, Nov 2024, Dec 2024, Jan 2025, Feb 2025, in that order,
       * every time, regardless of which months actually have postings.
       * Months with no matching open items still get a bucket (netAmt: 0,
       * hasData: false) so the chart always draws 6 bars, with genuinely
       * empty months rendered as a flat/zero bar instead of being skipped.
       * Falls back to today's date if no anchor date is available yet.
       */
      _computeLastTwelveMonthsTotals: function (aOpenItems, sAnchorDate) {
        var oAnchor = sAnchorDate ? new Date(sAnchorDate) : new Date();
        if (isNaN(oAnchor.getTime())) {
          oAnchor = new Date();
        }
        var iAnchorKey = oAnchor.getFullYear() * 12 + oAnchor.getMonth();

        var oBuckets = {};
        for (var i = 11; i >= 0; i--) {
          var iKey = iAnchorKey - i;
          var oMonthDate = new Date(
            Math.floor(iKey / 12),
            ((iKey % 12) + 12) % 12,
            1,
          );
          oBuckets[iKey] = {
            sortKey: iKey,
            label: oMonthDate.toLocaleString("en-US", {
              month: "short",
              year: "numeric",
            }),
            netAmt: 0,
            hasData: false,
          };
        }

        (aOpenItems || []).forEach(function (o) {
          if (!o.Budat) return;
          var oDate = o.Budat instanceof Date ? o.Budat : new Date(o.Budat);
          if (isNaN(oDate.getTime())) return;

          var iMonthIndex = oDate.getFullYear() * 12 + oDate.getMonth();
          var oBucket = oBuckets[iMonthIndex];
          if (!oBucket) return; // outside the fixed 12-month window
          oBucket.netAmt += parseFloat(o.NetAmt) || 0;
          oBucket.hasData = true;
        });

        var aMonths = Object.keys(oBuckets)
          .map(function (sKey) {
            return oBuckets[sKey];
          })
          .sort(function (a, b) {
            return a.sortKey - b.sortKey;
          });

        aMonths.forEach(function (o) {
          o.absNetAmt = Math.abs(o.netAmt);
        });

        return aMonths;
      },

      /**
       * Builds one calendar-month bucket for every month between
       * sFromDate and sToDate inclusive (used by the Transactions panel's
       * "Balance movement" chart, which spans whatever date range the user
       * searched â€" unlike the Opening balance chart's fixed 12-month
       * window). Falls back to a single month if the range is invalid or
       * inverted. Capped at 60 months so an accidentally huge range (e.g.
       * a multi-year To Date) can't blow up the chart.
       */
      _computeMonthsRangeTotals: function (aItems, sFromDate, sToDate) {
        var MAX_MONTHS = 60;

        var oFrom = sFromDate ? new Date(sFromDate) : new Date();
        var oTo = sToDate ? new Date(sToDate) : oFrom;
        if (isNaN(oFrom.getTime())) oFrom = new Date();
        if (isNaN(oTo.getTime())) oTo = oFrom;

        var iFromKey = oFrom.getFullYear() * 12 + oFrom.getMonth();
        var iToKey = oTo.getFullYear() * 12 + oTo.getMonth();
        if (iToKey < iFromKey) {
          var iTmp = iFromKey;
          iFromKey = iToKey;
          iToKey = iTmp;
        }
        if (iToKey - iFromKey > MAX_MONTHS - 1) {
          iToKey = iFromKey + MAX_MONTHS - 1;
        }

        var oBuckets = {};
        for (var iKey = iFromKey; iKey <= iToKey; iKey++) {
          var oMonthDate = new Date(
            Math.floor(iKey / 12),
            ((iKey % 12) + 12) % 12,
            1,
          );
          oBuckets[iKey] = {
            sortKey: iKey,
            label: oMonthDate.toLocaleString("en-US", {
              month: "short",
              year: "numeric",
            }),
            netAmt: 0,
            hasData: false,
          };
        }

        (aItems || []).forEach(function (o) {
          if (!o.Budat) return;
          var oDate = o.Budat instanceof Date ? o.Budat : new Date(o.Budat);
          if (isNaN(oDate.getTime())) return;

          var iMonthIndex = oDate.getFullYear() * 12 + oDate.getMonth();
          var oBucket = oBuckets[iMonthIndex];
          if (!oBucket) return; // outside the searched From/To Date range
          oBucket.netAmt += parseFloat(o.NetAmt) || 0;
          oBucket.hasData = true;
        });

        var aMonths = Object.keys(oBuckets)
          .map(function (sKey) {
            return oBuckets[sKey];
          })
          .sort(function (a, b) {
            return a.sortKey - b.sortKey;
          });

        aMonths.forEach(function (o) {
          o.absNetAmt = Math.abs(o.netAmt);
        });

        return aMonths;
      },

      /**
       * Computes the "vs prior period" percentage change for the tile atop
       * the Line items table: current month's NetAmt total vs. the month
       * immediately before it (chronologically, among months that actually
       * have data). With no month clicked, "current" defaults to the most
       * recent month and "prior" to the one before it â€" i.e. by default it
       * compares the last two bars in the chart; clicking any bar instead
       * compares that bar against the one immediately to its left.
       */
      _updateVsPriorPeriod: function (aMonthly, iSelectedKey) {
        var oReconModel = this._oReconModel;

        var iCurrentIdx =
          iSelectedKey !== null
            ? aMonthly.findIndex(function (o) {
                return o.sortKey === iSelectedKey;
              })
            : aMonthly.length - 1;

        if (iCurrentIdx < 0 || iCurrentIdx - 1 < 0) {
          oReconModel.setProperty("/mdVsPriorPercent", null);
          return;
        }

        var fCurrent = aMonthly[iCurrentIdx].netAmt;
        var fPrior = aMonthly[iCurrentIdx - 1].netAmt;
        var fPercent =
          fPrior !== 0
            ? ((fCurrent - fPrior) / Math.abs(fPrior)) * 100
            : fCurrent !== 0
              ? 100
              : 0;

        oReconModel.setProperty("/mdVsPriorPercent", fPercent);
      },

      /** "+X.X%"/"-X.X%" for the vs-prior-period tile, or "N/A" with no prior month to compare against. */
      formatVsPriorLabel: function (fValue) {
        if (fValue === null || fValue === undefined) return "N/A";
        return (fValue >= 0 ? "+" : "") + fValue.toFixed(1) + "%";
      },

      /**
       * Opens the "Payments â€" Select Period" dialog (fires from clicking
       * the "Payments" row in the Finance (FI) panel).
       */
      /**
       * Fired from the "Transactions" row in the master-detail Finance (FI)
       * panel. Calls transactionperiodSet for the current Company Code /
       * Supplier / date range (same Bukrs/Lifnr/From-To Date already loaded
       * on the page) and switches the right panel from "Opening balance"
       * line items into the Transactions section. For now the response is
       * only logged to the console for verification against the backend.
       */
      onTransactionsPress: function () {
        this._sActiveMdPanel = "transactions"; this._persistUiState();
        var sBukrs = this._sBukrs;
        var sLifnr = this._oReconModel.getProperty("/mdLifnr");
        var sFromDate = this._sKeyDate;

        if (!sBukrs || !sLifnr || !sFromDate) {
          MessageToast.show(
            "Company Code, Supplier and From Date are required.",
          );
          return;
        }

        // _showMdPanel runs BEFORE sToDate is read (not after, like the
        // filters used to be built) because it's the thing that swaps a
        // still-untouched FY-start default over to today â€" reading
        // _sKeyDateTo before that swap ran was capturing the stale
        // FY-start value on the very first non-Opening-Balance panel
        // pressed each session, so e.g. Total PO's very first query used
        // BudatFrom === BudatTo (a single day) instead of FY-start-to-today.
        this._showMdPanel("mdShowTransactions");
        var sToDate = this._sKeyDateTo;

        var oModel = this.getOwnerComponent().getModel();
        var oReconModel = this._oReconModel;

        var aFilters = [
          new Filter("Bukrs", FilterOperator.EQ, sBukrs),
          new Filter("Lifnr", FilterOperator.EQ, sLifnr),
          new Filter("FromDate", FilterOperator.EQ, new Date(sFromDate)),
        ];

        // Only constrain by ToDate when the user actually picked one â€"
        // when it's empty, the read should be From Date onward, not
        // silently reusing FromDate as both ends of the range.
        if (sToDate) {
          aFilters.push(
            new Filter("ToDate", FilterOperator.EQ, new Date(sToDate)),
          );
        }

        oReconModel.setProperty("/mdSelectedMonthLabel", "");
        oReconModel.setProperty("/transactionsBusy", true);

        var that = this;

        oModel.read("/transactionperiodSet", {
          filters: aFilters,
         
          success: function (oData) {
            var aRawResults = oData.results || [];
            console.log("transactionperiodSet response:", aRawResults);

            // transactionperiodSet uses lower-case "budat"/"Augdt" (unlike
            // OpenItemsSet/OpBalAsOnSet's "Budat"/"Augbl") â€" normalize into
            // the same {Belnr, Budat, Blart, NetAmt, Augbl} shape the Line
            // items / Payments tables already use.
            var aItems = aRawResults.map(function (o) {
              var fDmbtr = parseFloat(o.Dmbtr) || 0;
              var fSignedAmt = o.Shkzg === "H" ? -fDmbtr : fDmbtr;
              return {
                Belnr: o.Belnr,
                Budat: o.budat || o.Budat,
                Blart: o.Docty_desc || o.Blart,
                NetAmt: fSignedAmt,
                Augbl: o.Augdt,
                Bukrs: o.Bukrs || o.bukrs,
                Lifnr: o.Lifnr || o.lifnr,
                Name1: o.Name1 || o.name1,
                Sgtxt: o.Sgtxt || o.sgtxt,
                Rebzg: o.Rebzg || o.rebzg,
                Waers: o.Waers || o.waers,
                Bstat: o.Bstat || o.bstat,
                Bldat: o.Bldat || o.bldat,
                Umskz: o.Umskz || o.umskz,
                Shkzg: o.Shkzg,
              };
            });

            that._sortByBudatDesc(aItems);
            oReconModel.setProperty("/transactionItems", aItems);
            oReconModel.setProperty("/transactionsAll", aItems);
            oReconModel.setProperty("/transactionsTotal", that._sumNetAmt(aItems));
            oReconModel.setProperty("/transactionsBusy", false);
            if (aItems.length === 0) {
              MessageToast.show("No transactions found for this period.");
            }
            that._renderMonthlyBarChart(0);
          },
          error: function (oError) {
            console.log("transactionperiodSet read failed:", oError);
            oReconModel.setProperty("/transactionItems", []);
            oReconModel.setProperty("/transactionsAll", []);
            oReconModel.setProperty("/transactionsTotal", 0);
            oReconModel.setProperty("/transactionsBusy", false);
            MessageToast.show("Error loading transactions.");
          },
        });
      },

      /** Back button on the Transactions panel: returns to the Line items view. */
      onBackFromTransactions: function () {
        this._oReconModel.setProperty("/mdShowTransactions", false);
      },

      /**
       * Fired from every Finance/Materials/Quality sidebar row that has no
       * dedicated backend service wired up yet (Credit notes and all
       * Materials (MM)/Quality (QM) rows). Navigates the right panel to a
       * generic placeholder that names the row that was clicked, instead
       * of doing nothing, until each of those gets its own view.
       */
      onModuleRowPress: function (oEvent) {
        var sLabel = oEvent.getSource().data("moduleLabel") || "";
        var oReconModel = this._oReconModel;

        this._sActiveMdPanel = "generic"; this._persistUiState();
        this._sActiveMdPanelLabel = sLabel;

        this._showMdPanel("mdShowGenericModule");
        oReconModel.setProperty("/mdGenericModuleLabel", sLabel);
      },

      /**
       * Fired from the "Advance balance" row in the master-detail Finance
       * (FI) panel. Calls VendBalAdvSet for the current Company Code /
       * Supplier / key date, same Bukrs/Lifnr/Budat already loaded on the
       * page, and switches the right panel into the Advance balance
       * section. Dmbtr is signed the same way as Opening balance/
       * Transactions: Shkzg "H" (credit) is subtracted, everything else
       * added.
       */
      onAdvanceBalancePress: function () {
        this._sActiveMdPanel = "advance"; this._persistUiState();
        var sBukrs = this._sBukrs;
        var sLifnr = this._oReconModel.getProperty("/mdLifnr");

        if (!sBukrs || !sLifnr || !this._sKeyDateTo) {
          MessageToast.show(
            "Company Code, Supplier and From Date are required.",
          );
          return;
        }

        // _showMdPanel first: it swaps a still-untouched FY-start default
        // To Date over to today, and reading _sKeyDateTo before that swap
        // ran captured the stale FY-start value on the first non-Opening-
        // Balance panel pressed each session (see onTransactionsPress).
        this._showMdPanel("mdShowAdvance");
        var sToDate = this._sKeyDateTo;

        var oModel = this.getOwnerComponent().getModel();
        var oReconModel = this._oReconModel;

        // VendBalAdvSet expects Lifnr zero-padded to 10 digits in the filter
        // (e.g. "0001000047"), unlike OpBalAsOnSet/transactionperiodSet which
        // take it as entered â€" pad here the same way _onCategorySelected
        // pads Akont for VENDERSet.
        var sLifnrPadded = String(sLifnr).padStart(10, "0");
        var aFilters = [
          new Filter("Bukrs", FilterOperator.EQ, sBukrs),
          new Filter("Lifnr", FilterOperator.EQ, sLifnrPadded),
          new Filter("Budat", FilterOperator.EQ, new Date(sToDate)),
        ];

        oReconModel.setProperty("/advanceBusy", true);

        var that = this;

        oModel.read("/VendBalAdvSet", {
          filters: aFilters,
          success: function (oData) {
            var aRawResults = oData.results || [];
            if (aRawResults.length === 0) {
              MessageToast.show("No advance balance items found.");
            }

            var fTotal = 0;
            var aItems = aRawResults.map(function (o) {
              var fDmbtr = parseFloat(o.Dmbtr) || 0;
              var fSignedAmt = o.Shkzg === "H" ? -fDmbtr : fDmbtr;
              fTotal += fSignedAmt;
              return {
                Belnr: o.Belnr,
                Budat: o.Budat,
                Blart: o.Docty_desc || o.Blart,
                Umskz: o.Umskz,
                NetAmt: fSignedAmt,
                Bukrs: o.Bukrs,
                Lifnr: o.Lifnr,
                Name1: o.Name1,
                Sgtxt: o.Sgtxt,
                Rebzg: o.Rebzg,
                Waers: o.Waers,
                Bstat: o.Bstat,
                Bldat: o.Bldat,
                Shkzg: o.Shkzg,
                Augbl: o.Augdt,
              };
            });

            that._sortByBudatDesc(aItems);
            oReconModel.setProperty("/advanceItems", aItems);
            oReconModel.setProperty("/advanceTotal", fTotal);
            oReconModel.setProperty("/advanceBusy", false);
          },
          error: function () {
            oReconModel.setProperty("/advanceItems", []);
            oReconModel.setProperty("/advanceTotal", 0);
            oReconModel.setProperty("/advanceBusy", false);
            MessageToast.show("Error loading advance balance.");
          },
        });
      },

      /** Back navigation out of the Advance balance panel: returns to the Line items view. */
      onBackFromAdvance: function () {
        this._oReconModel.setProperty("/mdShowAdvance", false);
      },

      /**
       * Fired from the "Debit notes" row in the master-detail Finance (FI)
       * panel. Calls DebitAmt1Set for the current Company Code / Supplier
       * over the searched From/To Date range (BudatFrom/BudatTo, both EQ â€"
       * this service takes the range as two discrete filter values rather
       * than a Budat BT like Payments), e.g.:
       *   DebitAmt1Set?$filter=Bukrs eq '1000' and Lifnr eq '0001000481'
       *   and BudatFrom eq datetime'...' and BudatTo eq datetime'...'
       * DebitAmt1Set returns Dmbtr already as a plain positive amount (no
       * Shkzg sign to apply) and no per-row posting date.
       */
      onDebitNotesPress: function () {
        this._sActiveMdPanel = "debitnotes"; this._persistUiState();
        var sBukrs = this._sBukrs;
        var sLifnr = this._oReconModel.getProperty("/mdLifnr");
        var sFromDate = this._sKeyDate;

        if (!sBukrs || !sLifnr || !sFromDate) {
          MessageToast.show(
            "Company Code, Supplier and From Date are required.",
          );
          return;
        }

        // _showMdPanel first: it swaps a still-untouched FY-start default
        // To Date over to today, and reading _sKeyDateTo before that swap
        // ran captured the stale FY-start value on the first non-Opening-
        // Balance panel pressed each session (see onTransactionsPress).
        this._showMdPanel("mdShowDebitNotes");
        var sToDate = this._sKeyDateTo || this._sKeyDate;

        var oModel = this.getOwnerComponent().getModel();
        var oReconModel = this._oReconModel;

        // DebitAmt1Set expects Lifnr zero-padded to 10 digits, same as
        // VendBalAdvSet.
        var sLifnrPadded = String(sLifnr).padStart(10, "0");
        var aFilters = [
          new Filter("Bukrs", FilterOperator.EQ, sBukrs),
          new Filter("Lifnr", FilterOperator.EQ, sLifnrPadded),
          new Filter("BudatFrom", FilterOperator.EQ, new Date(sFromDate)),
          new Filter("BudatTo", FilterOperator.EQ, new Date(sToDate)),
        ];

        oReconModel.setProperty("/debitNotesBusy", true);

        var that = this;

        oModel.read("/DebitAmt1Set", {
          filters: aFilters,
          success: function (oData) {
            var aRawResults = oData.results || [];
            if (aRawResults.length === 0) {
              MessageToast.show("No debit notes found.");
            }

            var fTotal = 0;
            var aItems = aRawResults.map(function (o) {
              var fDmbtr = parseFloat(o.Dmbtr) || 0;
              fTotal += fDmbtr;
              return {
                Belnr: o.Belnr,
                Blart: o.Docty_desc || o.Blart,
                NetAmt: fDmbtr,
                Bukrs: o.Bukrs,
                Lifnr: o.Lifnr,
                Name1: o.Name1,
                Sgtxt: o.Sgtxt,
                Rebzg: o.Rebzg,
                Waers: o.Waers,
                Bstat: o.Bstat,
                Budat: o.Budat,
                Bldat: o.Bldat,
                Umskz: o.Umskz,
                Shkzg: o.Shkzg,
                Augbl: o.Augdt,
              };
            });

            oReconModel.setProperty("/debitNotesItems", aItems);
            oReconModel.setProperty("/debitNotesTotal", fTotal);
            oReconModel.setProperty("/debitNotesBusy", false);
          },
          error: function () {
            oReconModel.setProperty("/debitNotesItems", []);
            oReconModel.setProperty("/debitNotesTotal", 0);
            oReconModel.setProperty("/debitNotesBusy", false);
            MessageToast.show("Error loading debit notes.");
          },
        });
      },

      /** Back navigation out of the Debit notes panel: returns to the Line items view. */
      onBackFromDebitNotes: function () {
        this._oReconModel.setProperty("/mdShowDebitNotes", false);
      },

      /**
       * Fired from the "Closing Balance" row in the master-detail FINANCE
       * (FI) panel. Calls ClosingBalanceSet for the current Company Code /
       * Supplier as of a single date (Budat, EQ â€" not a BudatFrom/BudatTo
       * range like Debit Notes/Advance/Payments), e.g.:
       *   ClosingBalanceSet?$filter=Bukrs eq '1000' and
       *   Budat eq datetime'2026-09-09T00:00:00' and Lifnr eq '0001000047'
       * ClosingBalanceSet returns one row per FI document open as of that
       * date (Belnr/Blart/Dmbtr/Shkzg/Bukrs/Lifnr/Name1/Sgtxt/Rebzg/Waers/
       * Bstat/Budat/Bldat/Umskz/Augdt/DoctyDesc) â€" same 15-field shape as
       * every other FI table (Opening Balance/Transactions/Advance/Debit
       * Notes/Payments/Pending Invoices), so it shares their Column
       * Settings/Select Layout schema (see OI_TABLE_IDS) instead of getting
       * its own. Dmbtr has no sign applied (Shkzg is carried through as its
       * own column, same as Debit Notes) since "closing balance" is a
       * signed-both-ways document list, not a single net total.
       */
      onClosingBalancePress: function () {
        this._sActiveMdPanel = "closingbalance"; this._persistUiState();
        var sBukrs = this._sBukrs;
        var sLifnr = this._oReconModel.getProperty("/mdLifnr");

        if (!sBukrs || !sLifnr || !this._sKeyDateTo) {
          MessageToast.show(
            "Company Code, Supplier and From Date are required.",
          );
          return;
        }

        // _showMdPanel first: it swaps a still-untouched FY-start default
        // To Date over to today, and reading _sKeyDateTo before that swap
        // ran captured the stale FY-start value on the first non-Opening-
        // Balance panel pressed each session (see onTransactionsPress).
        this._showMdPanel("mdShowClosingBalance");
        var sToDate = this._sKeyDateTo;

        var oModel = this.getOwnerComponent().getModel();
        var oReconModel = this._oReconModel;

        // ClosingBalanceSet expects Lifnr zero-padded to 10 digits, same as
        // DebitAmt1Set/VendBalAdvSet, and takes a single "as of" Budat (EQ)
        // rather than a BudatFrom/BudatTo range â€" same "as of <To Date>"
        // shape as VendBalAdvSet (Advance balance)/PendInvValuesSet (Pending
        // invoices), not sKeyDate (From Date).
        var sLifnrPadded = String(sLifnr).padStart(10, "0");
        var aFilters = [
          new Filter("Bukrs", FilterOperator.EQ, sBukrs),
          new Filter("Lifnr", FilterOperator.EQ, sLifnrPadded),
          new Filter("Budat", FilterOperator.EQ, new Date(sToDate)),
        ];

        oReconModel.setProperty("/closingBalanceBusy", true);

        var that = this;

        oModel.read("/ClosingBalanceSet", {
          filters: aFilters,
          success: function (oData) {
            var aRawResults = oData.results || [];
            if (aRawResults.length === 0) {
              MessageToast.show("No closing balance items found.");
            }

            var fTotal = 0;
            var aItems = aRawResults.map(function (o) {
              var fDmbtr = parseFloat(o.Dmbtr) || 0;
              var fSignedAmt = o.Shkzg === "H" ? -fDmbtr : fDmbtr;
              fTotal += fSignedAmt;
              return {
                Belnr: o.Belnr,
                Blart: o.DoctyDesc || o.Blart,
                NetAmt: fSignedAmt,
                Bukrs: o.Bukrs,
                Lifnr: o.Lifnr,
                Name1: o.Name1,
                Sgtxt: o.Sgtxt,
                Rebzg: o.Rebzg,
                Waers: o.Waers,
                Bstat: o.Bstat,
                Budat: o.Budat,
                Bldat: o.Bldat,
                Umskz: o.Umskz,
                Shkzg: o.Shkzg,
                Augbl: o.Augdt,
              };
            });

            oReconModel.setProperty("/closingBalanceItems", aItems);
            oReconModel.setProperty("/closingBalanceTotal", fTotal);
            oReconModel.setProperty(
              "/closingBalanceSupplierName",
              oReconModel.getProperty("/mdSupplierName") || "",
            );
            oReconModel.setProperty("/closingBalanceBusy", false);
          },
          error: function () {
            oReconModel.setProperty("/closingBalanceItems", []);
            oReconModel.setProperty("/closingBalanceTotal", 0);
            oReconModel.setProperty("/closingBalanceBusy", false);
            MessageToast.show("Error loading closing balance.");
          },
        });
      },

      /** Back navigation out of the Closing Balance panel: returns to the Line items view. */
      onBackFromClosingBalance: function () {
        this._oReconModel.setProperty("/mdShowClosingBalance", false);
      },

      /**
       * Fired from the "Total PO value" row in the master-detail Materials
       * (MM) panel. Calls TotalPOSet for the current Company Code / Supplier
       * over the searched From/To Date range (BudatFrom/BudatTo, both EQ â€"
       * same two-discrete-filter pattern as Debit notes), e.g.:
       *   TotalPOSet?$filter=Bukrs eq '1000' and Lifnr eq '0001000093'
       *   and BudatFrom eq datetime'...' and BudatTo eq datetime'...'
       * TotalPOSet returns one row per PO item (Ebeln/Ebelp) with Netwr
       * already as a plain positive net value and Name1 as the vendor name
       * â€" summed for the "Total PO amount" stat tile, counted for
       * "Total PO items".
       */
      onTotalPOPress: function () {
        this._sActiveMdPanel = "totalpo"; this._persistUiState();
        var sBukrs = this._sBukrs;
        var sLifnr = this._oReconModel.getProperty("/mdLifnr");
        var sFromDate = this._sKeyDate;

        if (!sBukrs || !sLifnr || !sFromDate) {
          MessageToast.show(
            "Company Code, Supplier and From Date are required.",
          );
          return;
        }

        // _showMdPanel must run BEFORE sToDate is read, not after (like the
        // filters used to be built): it's what swaps a still-untouched
        // FY-start default To Date over to today. Reading _sKeyDateTo
        // before that swap ran meant the very first "Total PO value" press
        // each session (landing here straight from Opening Balance, whose
        // To Date still equals From Date/FY-start) queried TotalPOSet with
        // BudatFrom === BudatTo â€" a single day â€" instead of FY-start-to-
        // today, so it came back empty ("No Purchase Order Data") even for
        // suppliers with real PO history.
        this._showMdPanel("mdShowTotalPO");
        var sToDate = this._sKeyDateTo || this._sKeyDate;

        var oModel = this.getOwnerComponent().getModel();
        var oReconModel = this._oReconModel;

        // TotalPOSet expects Lifnr zero-padded to 10 digits, same as
        // VendBalAdvSet/DebitAmt1Set.
        var sLifnrPadded = String(sLifnr).padStart(10, "0");
        var aFilters = [
          new Filter("Bukrs", FilterOperator.EQ, sBukrs),
          new Filter("Lifnr", FilterOperator.EQ, sLifnrPadded),
          new Filter("BudatFrom", FilterOperator.EQ, new Date(sFromDate)),
          new Filter("BudatTo", FilterOperator.EQ, new Date(sToDate)),
        ];

        oReconModel.setProperty("/totalPOBusy", true);

        var that = this;

        oModel.read("/TotalPOSet", {
          filters: aFilters,
          success: function (oData) {
            var aRawResults = oData.results || [];
            if (aRawResults.length === 0) {
              MessageToast.show("No purchase order items found.");
            }

            var fTotal = 0;
            var fQtyTotal = 0;
            var sSupplierName = "";
            var aItems = aRawResults.map(function (o) {
              var fNetwr = parseFloat(o.Netwr) || 0;
              fTotal += fNetwr;
              fQtyTotal += parseFloat(o.Menge) || 0;
              sSupplierName = sSupplierName || o.Name1 || "";
              return {
                Ebeln: o.Ebeln,
                Ebelp: o.Ebelp,
                Bukrs: o.Bukrs,
                Lifnr: o.Lifnr,
                Name1: o.Name1,
                Bedat: o.Bedat,
                Bsart: o.Bsart,
                Bstyp: o.Bstyp,
                Matnr: o.Matnr,
                Txz01: o.Txz01,
                Maktx: o.Maktx,
                Menge: o.Menge,
                Meins: o.Meins,
                Netpr: o.Netpr,
                Peinh: o.Peinh,
                Netwr: fNetwr,
                Waers: o.Waers,
              };
            });

            // Split by Bstyp â€" "F" is a PO, "K" is a Contract â€" into the
            // two bars drawn by _renderTotalPOTypeBarChart (PO / Contract).
            var fPoAmount = 0,
              fContractAmount = 0;
            aItems.forEach(function (o) {
              if (o.Bstyp === "K") {
                fContractAmount += o.Netwr;
              } else {
                // "F" and anything unrecognized is treated as PO.
                fPoAmount += o.Netwr;
              }
            });
            var aTypeTotals = [
              { key: "F", label: "PO", amount: fPoAmount },
              { key: "K", label: "Contract", amount: fContractAmount },
            ];

            // Unique Material options for the Material filter popover
            // (onTotalPOMaterialFilterPress) â€" one entry per distinct
            // Matnr actually present in this read, labelled with its
            // description (Txz01) same as the table's own Material column,
            // so the checkbox list only ever offers values that can
            // actually narrow the table down.
            var aMaterialOptions = [];
            var oSeenMatnr = {};
            aItems.forEach(function (o) {
              if (o.Matnr && !oSeenMatnr[o.Matnr]) {
                oSeenMatnr[o.Matnr] = true;
                aMaterialOptions.push({
                  key: o.Matnr,
                  text: (o.Txz01 || o.Matnr) + " (" + o.Matnr + ")",
                });
              }
            });
            aMaterialOptions.sort(function (a, b) {
              return a.text.localeCompare(b.text);
            });

            oReconModel.setProperty("/totalPOItemsAll", aItems);
            oReconModel.setProperty("/totalPOItems", aItems);
            oReconModel.setProperty("/totalPOTotal", fTotal);
            oReconModel.setProperty("/totalPOQty", fQtyTotal);
            oReconModel.setProperty("/totalPOTypeTotals", aTypeTotals);
            oReconModel.setProperty("/mdTotalPOSelectedCategory", null);
            oReconModel.setProperty("/totalPOMaterialOptions", aMaterialOptions);
            oReconModel.setProperty("/totalPOSelectedMaterials", []);
            oReconModel.setProperty("/totalPOSupplierName", sSupplierName);
            oReconModel.setProperty("/totalPOBusy", false);

            // Draw straight away â€" don't wait for the chart tile's own
            // afterRendering, which only fires the first time this panel's
            // core:HTML is added to the DOM, not on every subsequent
            // "Total PO value" press (see _renderTotalPOTypeBarChart).
            that._renderTotalPOTypeBarChart(0);
          },
          error: function () {
            oReconModel.setProperty("/totalPOItemsAll", []);
            oReconModel.setProperty("/totalPOItems", []);
            oReconModel.setProperty("/totalPOTotal", 0);
            oReconModel.setProperty("/totalPOQty", 0);
            oReconModel.setProperty("/totalPOTypeTotals", []);
            oReconModel.setProperty("/mdTotalPOSelectedCategory", null);
            oReconModel.setProperty("/totalPOMaterialOptions", []);
            oReconModel.setProperty("/totalPOSelectedMaterials", []);
            oReconModel.setProperty("/totalPOBusy", false);
            that._renderTotalPOTypeBarChart(0);
            MessageToast.show("Error loading total PO value.");
          },
        });
      },

      /** Back navigation out of the Total PO value panel: returns to the Line items view. */
      onBackFromTotalPO: function () {
        this._oReconModel.setProperty("/mdShowTotalPO", false);
      },

      /**
       * Fired from the "Pending PO" row in the master-detail Materials (MM)
       * panel. Calls pendingpoSet for the current Company Code / Supplier
       * over the searched From/To Date range â€" pendingpoSet takes the range
       * as FromDate/ToDate (its own filter names, unlike TotalPOSet's
       * BudatFrom/BudatTo), e.g.:
       *   pendingpoSet?$filter=Bukrs eq '1000' and Lifnr eq '0001000093'
       *   and FromDate eq datetime'...' and ToDate eq datetime'...'
       * pendingpoSet returns one row per open PO item with PendQty (the
       * still-pending quantity) and PendVal (its net value, already a plain
       * positive amount) â€" summed for "Total pending PO amount", counted
       * for "Total pending PO items".
       */
      onPendingPOPress: function () {
        this._sActiveMdPanel = "pendingpo"; this._persistUiState();
        var sBukrs = this._sBukrs;
        var sLifnr = this._oReconModel.getProperty("/mdLifnr");
        var sFromDate = this._sKeyDate;

        if (!sBukrs || !sLifnr || !sFromDate) {
          MessageToast.show(
            "Company Code, Supplier and From Date are required.",
          );
          return;
        }

        // _showMdPanel first: it swaps a still-untouched FY-start default
        // To Date over to today, and reading _sKeyDateTo before that swap
        // ran captured the stale FY-start value on the first non-Opening-
        // Balance panel pressed each session (see onTransactionsPress).
        this._showMdPanel("mdShowPendingPO");
        var sToDate = this._sKeyDateTo || this._sKeyDate;

        var oModel = this.getOwnerComponent().getModel();
        var oReconModel = this._oReconModel;

        // pendingpoSet expects Lifnr zero-padded to 10 digits, same as
        // TotalPOSet/VendBalAdvSet/DebitAmt1Set.
        var sLifnrPadded = String(sLifnr).padStart(10, "0");
        var aFilters = [
          new Filter("Bukrs", FilterOperator.EQ, sBukrs),
          new Filter("Lifnr", FilterOperator.EQ, sLifnrPadded),
          new Filter("FromDate", FilterOperator.EQ, new Date(sFromDate)),
          new Filter("ToDate", FilterOperator.EQ, new Date(sToDate)),
        ];
        oReconModel.setProperty("/pendingPOBusy", true);

        var that = this;

        oModel.read("/pendingpoSet", {
          filters: aFilters,
          success: function (oData) {
            var aRawResults = oData.results || [];
            if (aRawResults.length === 0) {
              MessageToast.show("No pending PO items found.");
            }

            var fTotal = 0;
            var fQtyTotal = 0;
            var sSupplierName = "";
            var aItems = aRawResults.map(function (o) {
              var fPendVal = parseFloat(o.PendVal) || 0;
              fTotal += fPendVal;
              fQtyTotal += parseFloat(o.PendQty) || 0;
              sSupplierName = sSupplierName || o.Name1 || "";
              return {
                Ebeln: o.Ebeln,
                Ebelp: o.Ebelp,
                Bukrs: o.Bukrs,
                Lifnr: o.Lifnr,
                Name1: o.Name1,
                Bedat: o.Bedat,
                Bsart: o.Bsart,
                Bstyp: o.Bstyp,
                Matnr: o.Matnr,
                Txz01: o.Txz01,
                Maktx: o.Maktx,
                Menge: o.Menge,
                EketMenge: o.EketMenge,
                Wemng: o.Wemng,
                PendQty: o.PendQty,
                Meins: o.Meins,
                Netpr: o.Netpr,
                Peinh: o.Peinh,
                PendVal: fPendVal,
                Waers: o.Waers,
              };
            });

            // Split by Bstyp — same "F" is a PO, "K" is a Contract rule as
            // Total PO value — into the two bars drawn by
            // _renderPendingPOTypeBarChart (PO / Contract).
            var fPoAmount = 0,
              fContractAmount = 0;
            aItems.forEach(function (o) {
              if (o.Bstyp === "K") {
                fContractAmount += o.PendVal;
              } else {
                // "F" and anything unrecognized is treated as PO.
                fPoAmount += o.PendVal;
              }
            });
            var aTypeTotals = [
              { key: "F", label: "PO", amount: fPoAmount },
              { key: "K", label: "Contract", amount: fContractAmount },
            ];

            oReconModel.setProperty("/pendingPOItemsAll", aItems);
            oReconModel.setProperty("/pendingPOItems", aItems);
            oReconModel.setProperty("/pendingPOTotal", fTotal);
            oReconModel.setProperty("/pendingPOQty", fQtyTotal);
            oReconModel.setProperty("/pendingPOTypeTotals", aTypeTotals);
            oReconModel.setProperty("/mdPendingPOSelectedCategory", null);
            oReconModel.setProperty("/pendingPOSupplierName", sSupplierName);
            oReconModel.setProperty("/pendingPOBusy", false);

            // Draw straight away — don't wait for the chart tile's own
            // afterRendering, which only fires the first time this panel's
            // core:HTML is added to the DOM, not on every subsequent
            // "Pending PO" press (see _renderPendingPOTypeBarChart).
            that._renderPendingPOTypeBarChart(0);
          },
          error: function () {
            oReconModel.setProperty("/pendingPOItemsAll", []);
            oReconModel.setProperty("/pendingPOItems", []);
            oReconModel.setProperty("/pendingPOTotal", 0);
            oReconModel.setProperty("/pendingPOQty", 0);
            oReconModel.setProperty("/pendingPOTypeTotals", []);
            oReconModel.setProperty("/mdPendingPOSelectedCategory", null);
            oReconModel.setProperty("/pendingPOBusy", false);
            that._renderPendingPOTypeBarChart(0);
            MessageToast.show("Error loading pending PO.");
          },
        });
      },

      /** Back navigation out of the Pending PO panel: returns to the Line items view. */
      onBackFromPendingPO: function () {
        this._oReconModel.setProperty("/mdShowPendingPO", false);
        this._oReconModel.setProperty("/mdShowLotsAccepted", false);
        this._oReconModel.setProperty("/mdShowLotsReceived", false);
        this._oReconModel.setProperty("/mdShowRejectedQty", false);
        this._oReconModel.setProperty("/mdShowAcceptedQty", false);
        this._oReconModel.setProperty("/mdShowAudQty", false);
        this._oReconModel.setProperty("/mdShowShareOfBusiness", false);
        this._oReconModel.setProperty("/mdShowMatReceipts", false);
        this._oReconModel.setProperty("/mdShowVendorReturns", false);
      },

      /**
       * Fired from the "Lots accepted" row in the master-detail sidebar
       * (QUALITY (QM) group). Calls LotAcceptSet for the current Supplier
       * over the searched From/To Date range (Fromdate/Todate â€" LotAcceptSet's
       * own filter names). LotAcceptSet returns one row per accepted quality
       * lot: Prueflos (lot number), Werks (plant), Qkennzahl (acceptance %),
       * Losmenge (lot quantity) â€" summed for "Total accepted qty", counted
       * for "Total lots accepted". No Bukrs filter â€" LotAcceptSet is keyed
       * by Lifnr only, unlike TotalPOSet/pendingpoSet.
       */
      onLotsAcceptedPress: function () {
        this._sActiveMdPanel = "lotsaccepted"; this._persistUiState();
        var sLifnr = this._oReconModel.getProperty("/mdLifnr");
        var sFromDate = this._sKeyDate;

        if (!sLifnr || !sFromDate) {
          MessageToast.show("Supplier and From Date are required.");
          return;
        }

        // _showMdPanel first: it swaps a still-untouched FY-start default
        // To Date over to today, and reading _sKeyDateTo before that swap
        // ran captured the stale FY-start value on the first non-Opening-
        // Balance panel pressed each session (see onTransactionsPress).
        this._showMdPanel("mdShowLotsAccepted");
        var sToDate = this._sKeyDateTo || this._sKeyDate;

        var oModel = this.getOwnerComponent().getModel();
        var oReconModel = this._oReconModel;

        // LotAcceptSet expects Lifnr zero-padded to 10 digits, same as
        // TotalPOSet/pendingpoSet/VendBalAdvSet.
        var sLifnrPadded = String(sLifnr).padStart(10, "0");
        var aFilters = [
          new Filter("Lifnr", FilterOperator.EQ, sLifnrPadded),
          new Filter("Fromdate", FilterOperator.EQ, new Date(sFromDate)),
          new Filter("Todate", FilterOperator.EQ, new Date(sToDate)),
        ];
        oReconModel.setProperty("/lotsAcceptedBusy", true);

        var that = this;

        oModel.read("/LotAcceptSet", {
          filters: aFilters,
          success: function (oData) {
            var aRawResults = oData.results || [];
            if (aRawResults.length === 0) {
              MessageToast.show("No accepted lots found.");
            }

            var fTotal = 0;
            var aItems = aRawResults.map(function (o) {
              var fLosmenge = parseFloat(o.Losmenge) || 0;
              fTotal += fLosmenge;
              return {
                Prueflos: o.Prueflos,
                Werks: o.Werks,
                Art: o.Art,
                Matnr: o.Matnr,
                Maktx: o.Maktx,
                Lifnr: o.Lifnr,
                Vcode: o.Vcode,
                Qkennzahl: o.Qkennzahl,
                Charg: o.Charg,
                Losmenge: fLosmenge,
                Enstehdat: o.Enstehdat,
                Objnr: o.Objnr,
                Obtyp: o.Obtyp,
                Stat01: o.Stat01,
                Kzart: o.Kzart,
                Aufnr: o.Aufnr,
                Mblnr: o.Mblnr,
              };
            });

            oReconModel.setProperty("/lotsAcceptedItemsAll", aItems);
            oReconModel.setProperty("/lotsAcceptedItems", aItems);
            oReconModel.setProperty("/lotsAcceptedTotal", fTotal);
            oReconModel.setProperty("/lotsAcceptedCount", aItems.length);
            oReconModel.setProperty(
              "/lotsAcceptedSupplierName",
              oReconModel.getProperty("/mdSupplierName") || "",
            );
            oReconModel.setProperty("/lotsAcceptedBusy", false);
          },
          error: function () {
            oReconModel.setProperty("/lotsAcceptedItemsAll", []);
            oReconModel.setProperty("/lotsAcceptedItems", []);
            oReconModel.setProperty("/lotsAcceptedTotal", 0);
            oReconModel.setProperty("/lotsAcceptedCount", 0);
            oReconModel.setProperty("/lotsAcceptedBusy", false);
            MessageToast.show("Error loading accepted lots.");
          },
        });
      },

      /** Back navigation out of the Lots accepted panel: returns to the Line items view. */
      onBackFromLotsAccepted: function () {
        this._oReconModel.setProperty("/mdShowLotsAccepted", false);
        this._oReconModel.setProperty("/mdShowLotsReceived", false);
        this._oReconModel.setProperty("/mdShowRejectedQty", false);
        this._oReconModel.setProperty("/mdShowAcceptedQty", false);
        this._oReconModel.setProperty("/mdShowAudQty", false);
        this._oReconModel.setProperty("/mdShowShareOfBusiness", false);
        this._oReconModel.setProperty("/mdShowMatReceipts", false);
        this._oReconModel.setProperty("/mdShowVendorReturns", false);
      },

      /**
       * Fired from the "Lots received" row in the master-detail sidebar
       * (QUALITY (QM) group). Calls LotRecSet for the current Supplier
       * over the searched From/To Date range (FromDate/ToDate â€" LotRecSet's
       * own filter names). LotRecSet returns one row per received quality
       * lot: Prueflos (lot number), Werks (plant), Losmenge (lot quantity)
       * â€" summed for "Total received qty", counted for "Total lots
       * received". No Bukrs filter â€" LotRecSet is keyed by Lifnr only,
       * same as LotAcceptSet.
       */
      onLotsReceivedPress: function () {
        this._sActiveMdPanel = "lotsreceived"; this._persistUiState();
        var sLifnr = this._oReconModel.getProperty("/mdLifnr");
        var sFromDate = this._sKeyDate;

        if (!sLifnr || !sFromDate) {
          MessageToast.show("Supplier and From Date are required.");
          return;
        }

        // _showMdPanel first: it swaps a still-untouched FY-start default
        // To Date over to today, and reading _sKeyDateTo before that swap
        // ran captured the stale FY-start value on the first non-Opening-
        // Balance panel pressed each session (see onTransactionsPress).
        this._showMdPanel("mdShowLotsReceived");
        var sToDate = this._sKeyDateTo || this._sKeyDate;

        var oModel = this.getOwnerComponent().getModel();
        var oReconModel = this._oReconModel;

        // LotRecSet expects Lifnr zero-padded to 10 digits, same as
        // LotAcceptSet/TotalPOSet/pendingpoSet.
        var sLifnrPadded = String(sLifnr).padStart(10, "0");
        var aFilters = [
          new Filter("Lifnr", FilterOperator.EQ, sLifnrPadded),
          new Filter("FromDate", FilterOperator.EQ, new Date(sFromDate)),
          new Filter("ToDate", FilterOperator.EQ, new Date(sToDate)),
        ];
        oReconModel.setProperty("/lotsReceivedBusy", true);

        var that = this;

        oModel.read("/LotRecSet", {
          filters: aFilters,
          success: function (oData) {
            var aRawResults = oData.results || [];
            if (aRawResults.length === 0) {
              MessageToast.show("No received lots found.");
            }

            var fTotal = 0;
            var aItems = aRawResults.map(function (o) {
              var fLosmenge = parseFloat(o.Losmenge) || 0;
              fTotal += fLosmenge;
              return {
                Prueflos: o.Prueflos,
                Werks: o.Werks,
                Art: o.Art,
                Objnr: o.Objnr,
                Obtyp: o.Obtyp,
                Stat01: o.Stat01,
                Matnr: o.Matnr,
                Maktx: o.Maktx,
                Lifnr: o.Lifnr,
                Kzart: o.Kzart,
                Vcode: o.Vcode,
                Qkennzahl: o.Qkennzahl,
                Aufnr: o.Aufnr,
                Mblnr: o.Mblnr,
                Charg: o.Charg,
                Losmenge: fLosmenge,
                Enstehdat: o.Enstehdat,
              };
            });

            // Split by Vcode â€" a fixed set of ten bars, always drawn in
            // this order regardless of which codes this result actually
            // contains (0 for codes with no lots), counting lots rather
            // than summing Losmenge â€" into the bars drawn by
            // _renderLotsReceivedTypeBarChart. A/A1-A5 are "accepted"-style
            // codes (drawn blue); R/R1-R3 are "rejected"-style codes (drawn
            // red) â€" see LOTS_RECEIVED_CODES.
            var oByCode = {};
            LOTS_RECEIVED_CODES.forEach(function (sKey) {
              oByCode[sKey] = 0;
            });
            aItems.forEach(function (o) {
              if (Object.prototype.hasOwnProperty.call(oByCode, o.Vcode)) {
                oByCode[o.Vcode] += 1;
              }
            });
            var aTypeTotals = LOTS_RECEIVED_CODES.map(function (sKey) {
              return {
                key: sKey,
                label: sKey,
                amount: oByCode[sKey],
              };
            });

            oReconModel.setProperty("/lotsReceivedItemsAll", aItems);
            oReconModel.setProperty("/lotsReceivedItems", aItems);
            oReconModel.setProperty("/lotsReceivedTotal", fTotal);
            oReconModel.setProperty("/lotsReceivedCount", aItems.length);
            oReconModel.setProperty("/lotsReceivedTypeTotals", aTypeTotals);
            oReconModel.setProperty("/mdLotsReceivedSelectedCategory", null);
            oReconModel.setProperty(
              "/lotsReceivedSupplierName",
              oReconModel.getProperty("/mdSupplierName") || "",
            );
            oReconModel.setProperty("/lotsReceivedBusy", false);

            // Draw straight away â€" don't wait for the chart tile's own
            // afterRendering, which only fires the first time this panel's
            // core:HTML is added to the DOM, not on every subsequent "Lots
            // received" press (see _renderLotsReceivedTypeBarChart).
            that._renderLotsReceivedTypeBarChart(0);
          },
          error: function () {
            oReconModel.setProperty("/lotsReceivedItemsAll", []);
            oReconModel.setProperty("/lotsReceivedItems", []);
            oReconModel.setProperty("/lotsReceivedTotal", 0);
            oReconModel.setProperty("/lotsReceivedCount", 0);
            oReconModel.setProperty("/lotsReceivedTypeTotals", []);
            oReconModel.setProperty("/mdLotsReceivedSelectedCategory", null);
            oReconModel.setProperty("/lotsReceivedBusy", false);
            that._renderLotsReceivedTypeBarChart(0);
            MessageToast.show("Error loading received lots.");
          },
        });
      },

      /** Back navigation out of the Lots received panel: returns to the Line items view. */
      onBackFromLotsReceived: function () {
        this._oReconModel.setProperty("/mdShowLotsReceived", false);
        this._oReconModel.setProperty("/mdShowRejectedQty", false);
        this._oReconModel.setProperty("/mdShowAcceptedQty", false);
        this._oReconModel.setProperty("/mdShowAudQty", false);
        this._oReconModel.setProperty("/mdShowShareOfBusiness", false);
        this._oReconModel.setProperty("/mdShowMatReceipts", false);
        this._oReconModel.setProperty("/mdShowVendorReturns", false);
      },

      /**
       * Fired from the "Accepted qty" row in the master-detail sidebar
       * (MATERIALS (MM) group). Calls AcceptSet for the current Supplier
       * over the searched From/To Date range (Fromdate/Todate â€" AcceptSet's
       * own filter names, keyed by Lifnr only, same as LotRejectSet).
       * AcceptSet returns one row per accepted quality lot: Prueflos (lot
       * number), Werks (plant), Vcode (usage-decision code), Losmenge (lot
       * quantity) â€" summed for "Total accepted qty", counted for "Total
       * lots accepted". Same stat-tile + table layout as Rejected qty â€" no
       * chart.
       */
      onAcceptedQtyPress: function () {
        this._sActiveMdPanel = "acceptedqty"; this._persistUiState();
        var sLifnr = this._oReconModel.getProperty("/mdLifnr");
        var sFromDate = this._sKeyDate;

        if (!sLifnr || !sFromDate) {
          MessageToast.show("Supplier and From Date are required.");
          return;
        }

        // _showMdPanel first: it swaps a still-untouched FY-start default
        // To Date over to today, and reading _sKeyDateTo before that swap
        // ran captured the stale FY-start value on the first non-Opening-
        // Balance panel pressed each session (see onTransactionsPress).
        this._showMdPanel("mdShowAcceptedQty");
        var sToDate = this._sKeyDateTo || this._sKeyDate;

        var oModel = this.getOwnerComponent().getModel();
        var oReconModel = this._oReconModel;

        // AcceptSet expects Lifnr zero-padded to 10 digits, same as
        // LotRejectSet/LotRecSet/TotalPOSet/pendingpoSet.
        var sLifnrPadded = String(sLifnr).padStart(10, "0");
        var aFilters = [
          new Filter("Lifnr", FilterOperator.EQ, sLifnrPadded),
          new Filter("Fromdate", FilterOperator.EQ, new Date(sFromDate)),
          new Filter("Todate", FilterOperator.EQ, new Date(sToDate)),
        ];
        oReconModel.setProperty("/acceptedQtyBusy", true);

        oModel.read("/AcceptSet", {
          filters: aFilters,
          success: function (oData) {
            var aRawResults = oData.results || [];
            if (aRawResults.length === 0) {
              MessageToast.show("No accepted lots found.");
            }

            var fTotal = 0;
            var aItems = aRawResults.map(function (o) {
              var fLosmenge = parseFloat(o.Losmenge) || 0;
              fTotal += fLosmenge;
              return {
                Prueflos: o.Prueflos,
                Werks: o.Werks,
                Art: o.Art,
                Matnr: o.Matnr,
                Maktx: o.Maktx,
                Lifnr: o.Lifnr,
                Vcode: o.Vcode,
                Qkennzahl: o.Qkennzahl,
                Charg: o.Charg,
                Mblnr: o.Mblnr,
                Losmenge: fLosmenge,
                Enstehdat: o.Enstehdat,
                Objnr: o.Objnr,
                Obtyp: o.Obtyp,
                Stat01: o.Stat01,
                Kzart: o.Kzart,
                Aufnr: o.Aufnr,
              };
            });

            oReconModel.setProperty("/acceptedQtyItems", aItems);
            oReconModel.setProperty("/acceptedQtyTotal", fTotal);
            oReconModel.setProperty("/acceptedQtyCount", aItems.length);
            oReconModel.setProperty(
              "/acceptedQtySupplierName",
              oReconModel.getProperty("/mdSupplierName") || "",
            );
            oReconModel.setProperty("/acceptedQtyBusy", false);
          },
          error: function () {
            oReconModel.setProperty("/acceptedQtyItems", []);
            oReconModel.setProperty("/acceptedQtyTotal", 0);
            oReconModel.setProperty("/acceptedQtyCount", 0);
            oReconModel.setProperty("/acceptedQtyBusy", false);
            MessageToast.show("Error loading accepted lots.");
          },
        });
      },

      /** Back navigation out of the Accepted qty panel: returns to the Line items view. */
      onBackFromAcceptedQty: function () {
        this._oReconModel.setProperty("/mdShowAcceptedQty", false);
        this._oReconModel.setProperty("/mdShowRejectedQty", false);
        this._oReconModel.setProperty("/mdShowAudQty", false);
        this._oReconModel.setProperty("/mdShowShareOfBusiness", false);
        this._oReconModel.setProperty("/mdShowMatReceipts", false);
        this._oReconModel.setProperty("/mdShowVendorReturns", false);
      },

      /**
       * Fired from the "Rejected qty" row in the master-detail sidebar
       * (MATERIALS (MM) group). Calls LotRejectSet for the current Supplier
       * over the searched From/To Date range (Fromdate/Todate â€" LotRejectSet's
       * own filter names, same lowercase-"date" casing as LotAcceptSet).
       * LotRejectSet returns one row per rejected quality lot: Prueflos (lot
       * number), Werks (plant), Vcode (reject code), Losmenge (lot quantity)
       * â€" summed for "Total rejected qty", counted for "Total lots
       * rejected". No Bukrs filter â€" LotRejectSet is keyed by Lifnr only,
       * same as LotAcceptSet/LotRecSet.
       */
      onRejectedQtyPress: function () {
        this._sActiveMdPanel = "rejectedqty"; this._persistUiState();
        var sLifnr = this._oReconModel.getProperty("/mdLifnr");
        var sFromDate = this._sKeyDate;

        if (!sLifnr || !sFromDate) {
          MessageToast.show("Supplier and From Date are required.");
          return;
        }

        // _showMdPanel first: it swaps a still-untouched FY-start default
        // To Date over to today, and reading _sKeyDateTo before that swap
        // ran captured the stale FY-start value on the first non-Opening-
        // Balance panel pressed each session (see onTransactionsPress).
        this._showMdPanel("mdShowRejectedQty");
        var sToDate = this._sKeyDateTo || this._sKeyDate;

        var oModel = this.getOwnerComponent().getModel();
        var oReconModel = this._oReconModel;

        // LotRejectSet expects Lifnr zero-padded to 10 digits, same as
        // LotAcceptSet/LotRecSet/TotalPOSet/pendingpoSet.
        var sLifnrPadded = String(sLifnr).padStart(10, "0");
        var aFilters = [
          new Filter("Lifnr", FilterOperator.EQ, sLifnrPadded),
          new Filter("Fromdate", FilterOperator.EQ, new Date(sFromDate)),
          new Filter("Todate", FilterOperator.EQ, new Date(sToDate)),
        ];
        oReconModel.setProperty("/rejectedQtyBusy", true);

        oModel.read("/LotRejectSet", {
          filters: aFilters,
          success: function (oData) {
            var aRawResults = oData.results || [];
            if (aRawResults.length === 0) {
              MessageToast.show("No rejected lots found.");
            }

            var fTotal = 0;
            var aItems = aRawResults.map(function (o) {
              var fLosmenge = parseFloat(o.Losmenge) || 0;
              fTotal += fLosmenge;
              return {
                Prueflos: o.Prueflos,
                Werks: o.Werks,
                Art: o.Art,
                Matnr: o.Matnr,
                Maktx: o.Maktx,
                Lifnr: o.Lifnr,
                Vcode: o.Vcode,
                Qkennzahl: o.Qkennzahl,
                Charg: o.Charg,
                Losmenge: fLosmenge,
                Enstehdat: o.Enstehdat,
                Objnr: o.Objnr,
                Obtyp: o.Obtyp,
                Stat01: o.Stat01,
                Kzart: o.Kzart,
                Aufnr: o.Aufnr,
                Mblnr: o.Mblnr,
              };
            });

            oReconModel.setProperty("/rejectedQtyItems", aItems);
            oReconModel.setProperty("/rejectedQtyTotal", fTotal);
            oReconModel.setProperty("/rejectedQtyCount", aItems.length);
            oReconModel.setProperty(
              "/rejectedQtySupplierName",
              oReconModel.getProperty("/mdSupplierName") || "",
            );
            oReconModel.setProperty("/rejectedQtyBusy", false);
          },
          error: function () {
            oReconModel.setProperty("/rejectedQtyItems", []);
            oReconModel.setProperty("/rejectedQtyTotal", 0);
            oReconModel.setProperty("/rejectedQtyCount", 0);
            oReconModel.setProperty("/rejectedQtyBusy", false);
            MessageToast.show("Error loading rejected lots.");
          },
        });
      },

      /** Back navigation out of the Rejected qty panel: returns to the Line items view. */
      onBackFromRejectedQty: function () {
        this._oReconModel.setProperty("/mdShowRejectedQty", false);
        this._oReconModel.setProperty("/mdShowAcceptedQty", false);
        this._oReconModel.setProperty("/mdShowAudQty", false);
        this._oReconModel.setProperty("/mdShowShareOfBusiness", false);
        this._oReconModel.setProperty("/mdShowMatReceipts", false);
        this._oReconModel.setProperty("/mdShowVendorReturns", false);
      },

      /**
       * Fired from the "AUD qty" row in the master-detail sidebar (QUALITY
       * (QM) group). Calls LotAUDSet for the current Supplier over the
       * searched From/To Date range (Fromdate/Todate â€" LotAUDSet's own
       * filter names, keyed by Lifnr only, same as LotAcceptSet/LotRejectSet).
       * LotAUDSet returns one row per AUD quality lot: Prueflos (lot
       * number), Werks (plant), Vcode (usage-decision code), Losmenge (lot
       * quantity) â€" summed for "Total AUD qty", counted for "Total lots
       * AUD". Same stat-tile + table + chart layout as Lots accepted, but
       * with four bars â€" A1/A2/A3/A5 â€" instead of two.
       */
      onAudQtyPress: function () {
        this._sActiveMdPanel = "audqty"; this._persistUiState();
        var sLifnr = this._oReconModel.getProperty("/mdLifnr");
        var sFromDate = this._sKeyDate;

        if (!sLifnr || !sFromDate) {
          MessageToast.show("Supplier and From Date are required.");
          return;
        }

        // _showMdPanel first: it swaps a still-untouched FY-start default
        // To Date over to today, and reading _sKeyDateTo before that swap
        // ran captured the stale FY-start value on the first non-Opening-
        // Balance panel pressed each session (see onTransactionsPress).
        this._showMdPanel("mdShowAudQty");
        var sToDate = this._sKeyDateTo || this._sKeyDate;

        var oModel = this.getOwnerComponent().getModel();
        var oReconModel = this._oReconModel;

        // LotAUDSet expects Lifnr zero-padded to 10 digits, same as
        // LotAcceptSet/LotRejectSet/TotalPOSet/pendingpoSet.
        var sLifnrPadded = String(sLifnr).padStart(10, "0");
        var aFilters = [
          new Filter("Lifnr", FilterOperator.EQ, sLifnrPadded),
          new Filter("Fromdate", FilterOperator.EQ, new Date(sFromDate)),
          new Filter("Todate", FilterOperator.EQ, new Date(sToDate)),
        ];
        oReconModel.setProperty("/audQtyBusy", true);

        var that = this;

        oModel.read("/LotAUDSet", {
          filters: aFilters,
          success: function (oData) {
            var aRawResults = oData.results || [];
            if (aRawResults.length === 0) {
              MessageToast.show("No AUD lots found.");
            }

            var fTotal = 0;
            var aItems = aRawResults.map(function (o) {
              var fLosmenge = parseFloat(o.Losmenge) || 0;
              fTotal += fLosmenge;
              return {
                Prueflos: o.Prueflos,
                Werks: o.Werks,
                Art: o.Art,
                Matnr: o.Matnr,
                Maktx: o.Maktx,
                Lifnr: o.Lifnr,
                Vcode: o.Vcode,
                Qkennzahl: o.Qkennzahl,
                Charg: o.Charg,
                Mblnr: o.Mblnr,
                Losmenge: fLosmenge,
                Enstehdat: o.Enstehdat,
                Objnr: o.Objnr,
                Obtyp: o.Obtyp,
                Stat01: o.Stat01,
                Kzart: o.Kzart,
                Aufnr: o.Aufnr,
              };
            });

            oReconModel.setProperty("/audQtyItemsAll", aItems);
            oReconModel.setProperty("/audQtyItems", aItems);
            oReconModel.setProperty("/audQtyTotal", fTotal);
            oReconModel.setProperty("/audQtyCount", aItems.length);
            oReconModel.setProperty(
              "/audQtySupplierName",
              oReconModel.getProperty("/mdSupplierName") || "",
            );
            oReconModel.setProperty("/audQtyBusy", false);
          },
          error: function () {
            oReconModel.setProperty("/audQtyItemsAll", []);
            oReconModel.setProperty("/audQtyItems", []);
            oReconModel.setProperty("/audQtyTotal", 0);
            oReconModel.setProperty("/audQtyCount", 0);
            oReconModel.setProperty("/audQtyBusy", false);
            MessageToast.show("Error loading AUD lots.");
          },
        });
      },

      /** Back navigation out of the AUD qty panel: returns to the Line items view. */
      onBackFromAudQty: function () {
        this._oReconModel.setProperty("/mdShowAudQty", false);
        this._oReconModel.setProperty("/mdShowShareOfBusiness", false);
      },

      /**
       * Fired from the "Share of Business" row in the master-detail sidebar
       * (MATERIALS (MM) group). Calls ShareOfBusinessSet for the current
       * Supplier over the searched From/To Date range (Fromdate/Todate),
       * keyed by Lifnr only, same padding convention as LotAUDSet/
       * TotalPOSet. ShareOfBusinessSet returns a single summary row — Menge/
       * Netwr (this supplier's quantity/value), SobMenge/SobNetwr (this
       * supplier's % share of qty/value), TotalQty/TotalAmt (company-wide
       * totals) — rendered as a field/value table instead of a line-item
       * list since there's only ever one row.
       * 
       */
        getPercentageColor: function (value) {
          debugger; 

    if (Number(value) >= 100) {
        return "greenCell";
    } else {
        return "redCell";
    }

},
      onShareOfBusinessPress: function (oEvent) {
       
        this._sActiveMdPanel = "shareofbusiness"; this._persistUiState();
        var sLifnr = this._oReconModel.getProperty("/mdLifnr");
        var sFromDate = this._sKeyDate;

        if (!sLifnr || !sFromDate) {
          MessageToast.show("Supplier and From Date are required.");
          return;
        }

        // _showMdPanel first: it swaps a still-untouched FY-start default
        // To Date over to today, and reading _sKeyDateTo before that swap
        // ran captured the stale FY-start value on the first non-Opening-
        // Balance panel pressed each session (see onTransactionsPress).
        this._showMdPanel("mdShowShareOfBusiness");
        var sToDate = this._sKeyDateTo || this._sKeyDate;

        var oModel = this.getOwnerComponent().getModel();
        var oReconModel = this._oReconModel;
        var that = this;

        var sLifnrPadded = String(sLifnr).padStart(10, "0");
        var aFilters = [
          new Filter("Lifnr", FilterOperator.EQ, sLifnrPadded),
          new Filter("Fromdate", FilterOperator.EQ, new Date(sFromDate)),
          new Filter("Todate", FilterOperator.EQ, new Date(sToDate)),
        ];
        oReconModel.setProperty("/shareOfBusinessBusy", true);
        oReconModel.setProperty("/shareLifnrItems", []);
        oReconModel.setProperty("/shareLifnrLabel", "");
        // Fresh entry (including the Refresh button, same as every other
        // panel's own refresh reloading with the current vendor) — always
        // start on the normal Quantity/Value view, not the Total Qty one.
        // /totalShareBusinessItems must be cleared too, not just the
        // active flag: the Total Qty Breakdown table's own visibility only
        // checks its items length, so leaving stale items in place kept it
        // on screen after refresh even once the four boxes came back.
        oReconModel.setProperty("/totalShareBusinessActive", false);
        oReconModel.setProperty("/totalShareBusinessItems", []);

        oModel.read("/ShareOfBusinessSet", {
          filters: aFilters,
          success: function (oData) {
            var aRawResults = oData.results || [];
            var o = aRawResults[0] || {};

            // Menge/Netwr/TotalQty/TotalAmt get the usual thousands-separator
            // number formatting, but SobMenge/SobNetwr (the % share fields)
            // are kept as the exact string the backend sent — no rounding —
            // since the backend already returns them at whatever precision
            // it wants shown (e.g. "1.996", not "2.00").
            var aItems = [
              { Label: "Quantity", Value: parseFloat(o.Menge) || 0, Raw: false, Icon: "sap-icon://shipping-status" },
              { Label: "Total Qty ", Value: parseFloat(o.TotalQty) || 0, Raw: false, Icon: "sap-icon://sum" },
              { Label: "Share of Qty (%)", Value: o.SobMenge != null && String(o.SobMenge).trim() !== "" && !isNaN(parseFloat(o.SobMenge)) ? String(o.SobMenge) : "0", Raw: true, Icon: "sap-icon://pie-chart" },
              { Label: "Value", Value: parseFloat(o.Netwr) || 0, Raw: false, Icon: "sap-icon://money-bills" },
              { Label: "Total Amount ", Value: parseFloat(o.TotalAmt) || 0, Raw: false, Icon: "sap-icon://sum" },
              { Label: "Share of Value (%)", Value: o.SobNetwr != null && String(o.SobNetwr).trim() !== "" && !isNaN(parseFloat(o.SobNetwr)) ? String(o.SobNetwr) : "0", Raw: true, Icon: "sap-icon://pie-chart" },
            ];

            if (aRawResults.length === 0) {
              MessageToast.show("No Share of Business data found.");
            }

            oReconModel.setProperty("/shareOfBusinessItems", aItems);
            oReconModel.setProperty(
              "/shareOfBusinessSupplierName",
              oReconModel.getProperty("/mdSupplierName") || "",
            );
            // Surfaced separately (not just inside shareOfBusinessItems) so the
            // "Share of Business" row in the left sidebar (Main.view.xml) can
            // show the qty share % the same way every other module row shows
            // its own summary figure.
            oReconModel.setProperty(
              "/shareOfBusinessQtyPercent",
              o.SobMenge != null && String(o.SobMenge).trim() !== "" && !isNaN(parseFloat(o.SobMenge))
                ? String(o.SobMenge)
                : "",
            );
            oReconModel.setProperty("/shareOfBusinessBusy", false);
            that._wireSobTileClicks();
            
          },
          error: function () {
            oReconModel.setProperty("/shareOfBusinessItems", []);
            oReconModel.setProperty("/shareOfBusinessBusy", false);
            MessageToast.show("Error loading Share of Business.");
          },
        });
      },

      /**
       * Attaches a direct "click" handler to the Quantity/Value boxes
       * (literal ids "sobQuantityBox"/"sobValueBox" — ShareOfBusinessPanel.fragment.xml
       * no longer uses an items-aggregation grid, each of the six boxes is
       * its own named control bound to a fixed shareOfBusinessItems/N/Value
       * index) once ShareOfBusinessSet's rows have been set on the model.
       * Guarded with a flag on each control so re-running this after every
       * refresh doesn't stack duplicate handlers.
       */
      _wireSobTileClicks: function () {
        var that = this;
        [
          { id: "sobQuantityBox", label: "Quantity" },
          { id: "sobValueBox", label: "Value" },
        ].forEach(function (o) {
          var oBox = that.byId(o.id);
          if (!oBox || oBox._sobClickWired) return;
          oBox._sobClickWired = true;
          oBox.attachBrowserEvent("click", function () {
            that._loadShareLifnrBreakdown(o.label);
          });
        });

        // "Total Qty" box wired separately — it drives its own table
        // (_loadTotalShareBusinessBreakdown / TotalShareBusinessSet), not
        // the Quantity/Value ShareLifnrSet breakdown above.
        var oTotalQtyBox = that.byId("sobTotalQtyBox");
        if (oTotalQtyBox && !oTotalQtyBox._sobClickWired) {
          oTotalQtyBox._sobClickWired = true;
          oTotalQtyBox.attachBrowserEvent("click", function () {
            that._loadTotalShareBusinessBreakdown();
          });
        }
      },

      /** Back navigation out of the Share of Business panel: returns to the Line items view. */
      onBackFromShareOfBusiness: function () {
        this._oReconModel.setProperty("/mdShowShareOfBusiness", false);
        this._oReconModel.setProperty("/totalShareBusinessActive", false);
        this._oReconModel.setProperty("/totalShareBusinessItems", []);
      },

      /**
       * Fired (via _wireSobTileClicks) when the Quantity or Value box on
       * the Share of Business panel is clicked. Calls ShareLifnrSet for the
       * current Company Code/Supplier over the searched From/To Date range
       * (Bukrs/Lifnr/BudatFrom/BudatTo), and renders the result rows as a
       * compact list directly below the box grid. Boxes other than
       * Quantity/Value are not wired to this at all (see
       * _wireSobTileClicks), so the Label guard below is just a safety net.
       */
      _loadShareLifnrBreakdown: function (sLabel) {
        if (sLabel !== "Quantity" && sLabel !== "Value") {
          return;
        }

        var oReconModel = this._oReconModel;
        var sBukrs = oReconModel.getProperty("/mdBukrs") || oReconModel.getProperty("/bukrs");
        var sLifnr = oReconModel.getProperty("/mdLifnr");
        var sFromDate = this._sKeyDate;
        var sToDate = this._sKeyDateTo || this._sKeyDate;

        if (!sLifnr || !sFromDate) {
          MessageToast.show("Supplier and From Date are required.");
          return;
        }

        var oModel = this.getOwnerComponent().getModel();
        var sLifnrPadded = String(sLifnr).padStart(10, "0");
        var aFilters = [
          new Filter("Bukrs", FilterOperator.EQ, sBukrs),
          new Filter("Lifnr", FilterOperator.EQ, sLifnrPadded),
          new Filter("BudatFrom", FilterOperator.EQ, new Date(sFromDate)),
          new Filter("BudatTo", FilterOperator.EQ, new Date(sToDate)),
        ];

        oReconModel.setProperty("/shareLifnrLabel", sLabel);
        oReconModel.setProperty("/shareLifnrBusy", true);
        // Switching to Quantity/Value leaves the Total Qty view, so
        // Supplier/From Date and the four Quantity/Share of Qty/Value/
        // Share of Value boxes go back to normal. Also clear
        // /totalShareBusinessItems (not just the active flag) — its own
        // table's visible binding only checks its items length, so
        // leaving stale items around let both breakdown tables show at
        // once.
        oReconModel.setProperty("/totalShareBusinessActive", false);
        oReconModel.setProperty("/totalShareBusinessItems", []);

        oModel.read("/ShareLifnrSet", {
          filters: aFilters,
          success: function (oData) {
            var aItems = oData.results || [];
            if (aItems.length === 0) {
              MessageToast.show("No " + sLabel + " breakdown data found.");
            }
            oReconModel.setProperty("/shareLifnrItems", aItems);
            oReconModel.setProperty("/sobAllShareLifnrItems", aItems);
            oReconModel.setProperty("/shareLifnrBusy", false);
          },
          error: function () {
            oReconModel.setProperty("/shareLifnrItems", []);
            oReconModel.setProperty("/shareLifnrBusy", false);
            MessageToast.show("Error loading " + sLabel + " breakdown.");
          },
        });
      },

      /**
       * Fired (via _wireSobTileClicks) when the "Total Qty" box on the
       * Share of Business panel is clicked. Calls TotalShareBusinessSet
       * filtered by BudatFrom only (company-wide, not scoped to a single
       * supplier/Bukrs â€" unlike ShareLifnrSet), e.g.:
       *   TotalShareBusinessSet?$filter=BudatFrom eq datetime'2025-04-01T00:00:00'
       * and renders every supplier's row (Lifnr/Name1/Menge/Netwr/SobMenge/
       * PrevMenge/PrevNetwr/SobPrevMenge) in its own table, same pattern as
       * _loadShareLifnrBreakdown's table just below the box grid.
       *
       * TotalShareBusinessSet is company-wide (BudatFrom/BudatTo only, no
       * Bukrs/Lifnr filter — see the URL above), so while this view is
       * showing the Supplier input is locked (Main.view.xml's inputLifnr)
       * and the per-supplier Quantity/Share of Qty/Value/Share of Value
       * boxes are hidden (ShareOfBusinessPanel.fragment.xml) via
       * /totalShareBusinessActive — editing Supplier wouldn't change this
       * table's (unfiltered-by-supplier) data. From/To Date stay editable
       * (this call uses both), and pressing Go re-fires this with the new
       * range — see the "shareofbusiness" case in onSearch's switch.
       */
      _loadTotalShareBusinessBreakdown: function () {
        var oReconModel = this._oReconModel;
        var sFromDate = this._sKeyDate;
        var sToDate = this._sKeyDateTo || this._sKeyDate;
        var sLifnr = oReconModel.getProperty("/mdLifnr");

        if (!sFromDate) {
          MessageToast.show("From Date is required.");
          return;
        }

        var oModel = this.getOwnerComponent().getModel();
        var aFilters = [
          new Filter("Lifnr", FilterOperator.EQ, sLifnr),
          new Filter("BudatFrom", FilterOperator.EQ, new Date(sFromDate)),
          new Filter("BudatTo", FilterOperator.EQ, new Date(sToDate)),
        ];

        oReconModel.setProperty("/totalShareBusinessLabel", "Total Qty");
        oReconModel.setProperty("/totalShareBusinessBusy", true);
        oReconModel.setProperty("/totalShareBusinessActive", true);
        // Clear the Quantity/Value breakdown (shareLifnrTable) — its own
        // visible binding only checks its items length, so leaving stale
        // items around let both breakdown tables show at once.
        oReconModel.setProperty("/shareLifnrItems", []);
        oReconModel.setProperty("/shareLifnrLabel", "");

        oModel.read("/TotalShareBusinessSet", {
          filters: aFilters,
          success: function (oData) {
            var aItems = oData.results || [];

            if (aItems.length === 0) {
              MessageToast.show("No Total Qty breakdown data found.");
            }
            oReconModel.setProperty("/totalShareBusinessItems", aItems);
            oReconModel.setProperty("/sobAllTotalShareBusinessItems", aItems);
            oReconModel.setProperty("/totalShareBusinessBusy", false);
          },
          error: function () {
            oReconModel.setProperty("/totalShareBusinessItems", []);
            oReconModel.setProperty("/totalShareBusinessBusy", false);
            MessageToast.show("Error loading Total Qty breakdown.");
          },
        });
      },

      _loadTotalShareBusinessBreakdownFiltered: function (aSelectedMatnrs) {
        var oReconModel = this._oReconModel;
        var sFromDate = this._sKeyDate;
        var sToDate = this._sKeyDateTo || this._sKeyDate;
        var sLifnr = oReconModel.getProperty("/mdLifnr");

        if (!sFromDate || !aSelectedMatnrs || aSelectedMatnrs.length === 0) {
          MessageToast.show("From Date and materials are required.");
          return;
        }

        var oModel = this.getOwnerComponent().getModel();
        oReconModel.setProperty("/totalShareBusinessBusy", true);

        // Build OR filter for multiple materials
        var aMatnrFilters = [];
        aSelectedMatnrs.forEach(function (sMatnr) {
          aMatnrFilters.push(new Filter("Matnr", FilterOperator.EQ, sMatnr));
        });

        // Create combined filters: Lifnr AND (Matnr OR Matnr OR ...) AND BudatFrom AND BudatTo
        var aFilters = [
          new Filter("Lifnr", FilterOperator.EQ, sLifnr),
          new Filter({
            filters: aMatnrFilters,
            and: false  // OR condition
          }),
          new Filter("BudatFrom", FilterOperator.EQ, new Date(sFromDate)),
          new Filter("BudatTo", FilterOperator.EQ, new Date(sToDate)),
        ];

        var that = this;

        oModel.read("/TotShareMatBusinessSet", {
          filters: aFilters,
          success: function (oData) {
            var aItems = oData.results || [];
            oReconModel.setProperty("/totalShareBusinessItems", aItems);

            // Calculate totals from filtered results
            that._calculateTotalQtyAndAmount(aItems);

            oReconModel.setProperty("/totalShareBusinessBusy", false);
            if (aItems.length === 0) {
              MessageToast.show("No data found for selected material(s).");
            } else {
              MessageToast.show("Loaded " + aItems.length + " record(s).");
            }
          },
          error: function (oError) {
            oReconModel.setProperty("/totalShareBusinessItems", []);
            oReconModel.setProperty("/totalShareBusinessBusy", false);
            MessageToast.show("Error loading filtered Total Qty breakdown: " + (oError.message || "Unknown error"));
          }
        });
      },

      _calculateTotalQtyAndAmount: function (aItems) {
        var fTotalQty = 0;
        var fTotalAmount = 0;

        if (aItems && aItems.length > 0) {
          aItems.forEach(function (item) {
            fTotalQty += parseFloat(item.Menge) || 0;
            fTotalAmount += parseFloat(item.Netwr) || 0;
          });
        }

        var oReconModel = this._oReconModel;
        oReconModel.setProperty("/shareOfBusinessItems/1/Value", fTotalQty);
        oReconModel.setProperty("/shareOfBusinessItems/4/Value", fTotalAmount);
      },

      /**
       * Fired from the "Material receipts" row in the master-detail
       * Materials (MM) panel. Calls MatReceiptSet for the current Company
       * Code / Supplier over the searched From/To Date range (Fromdate/
       * Todate â€" MatReceiptSet's own filter names, same as LotAcceptSet/
       * LotAUDSet but with a Bukrs filter too, like TotalPOSet). MatReceiptSet
       * returns one row per goods-receipt line: Mblnr (material document),
       * Werks (plant), Ebeln (PO number), Bwart (movement type), Menge
       * (quantity), Budat_mkpf (posting date) â€" counted for "Material
       * receipt items", no amount/chart (goods receipts have no value
       * field to chart or sum).
       */
      onMaterialReceiptsPress: function () {
        this._sActiveMdPanel = "matreceipts"; this._persistUiState();
        var sBukrs = this._sBukrs;
        var sLifnr = this._oReconModel.getProperty("/mdLifnr");
        var sFromDate = this._sKeyDate;

        if (!sBukrs || !sLifnr || !sFromDate) {
          MessageToast.show(
            "Company Code, Supplier and From Date are required.",
          );
          return;
        }

        // _showMdPanel first: it swaps a still-untouched FY-start default
        // To Date over to today, and reading _sKeyDateTo before that swap
        // ran captured the stale FY-start value on the first non-Opening-
        // Balance panel pressed each session (see onTransactionsPress).
        this._showMdPanel("mdShowMatReceipts");
        var sToDate = this._sKeyDateTo || this._sKeyDate;

        var oModel = this.getOwnerComponent().getModel();
        var oReconModel = this._oReconModel;

        // MatReceiptSet expects Lifnr zero-padded to 10 digits, same as
        // TotalPOSet/LotAcceptSet/VendBalAdvSet.
        var sLifnrPadded = String(sLifnr).padStart(10, "0");
        var aFilters = [
          new Filter("Bukrs", FilterOperator.EQ, sBukrs),
          new Filter("Lifnr", FilterOperator.EQ, sLifnrPadded),
          new Filter("Fromdate", FilterOperator.EQ, new Date(sFromDate)),
          new Filter("Todate", FilterOperator.EQ, new Date(sToDate)),
        ];
        oReconModel.setProperty("/matReceiptsBusy", true);

        var that = this;

        oModel.read("/MatReceiptSet", {
          filters: aFilters,
          success: function (oData) {
            var aRawResults = oData.results || [];
            if (aRawResults.length === 0) {
              MessageToast.show("No material receipts found.");
            }

            var fTotal = 0;
            var aItems = aRawResults.map(function (o) {
              var fMenge = parseFloat(o.Menge) || 0;
              fTotal += fMenge;
              return {
                Mblnr: o.Mblnr,
                Zeile: o.Zeile,
                Werks: o.Werks,
                Bukrs: o.Bukrs,
                Gjahr: o.Gjahr,
                Lifnr: o.Lifnr,
                Ebeln: o.Ebeln,
                Ebelp: o.Ebelp,
                Bwart: o.Bwart,
                Matnr: o.Matnr,
                Maktx: o.Maktx,
                Lgort: o.Lgort,
                Menge: fMenge,
                Meins: o.Meins,
                Budat_mkpf: o.Budat_mkpf,
                Dmbtr: parseFloat(o.Dmbtr) || 0,
              };
            });

            oReconModel.setProperty("/matReceiptsItems", aItems);
            oReconModel.setProperty("/matReceiptsTotal", fTotal);
            oReconModel.setProperty(
              "/matReceiptsSupplierName",
              oReconModel.getProperty("/mdSupplierName") || "",
            );
            oReconModel.setProperty("/matReceiptsBusy", false);
          },
          error: function () {
            oReconModel.setProperty("/matReceiptsItems", []);
            oReconModel.setProperty("/matReceiptsTotal", 0);
            oReconModel.setProperty("/matReceiptsBusy", false);
            MessageToast.show("Error loading material receipts.");
          },
        });
      },

      /** Back navigation out of the Material receipts panel: returns to the Line items view. */
      onBackFromMatReceipts: function () {
        this._oReconModel.setProperty("/mdShowMatReceipts", false);
        this._oReconModel.setProperty("/mdShowVendorReturns", false);
      },

      /**
       * Fired from the "Vendor returns" row in the master-detail Materials
       * (MM) panel, nested under Material receipts. Calls VendorReturnsSet
       * for the current Company Code / Supplier over the searched From/To
       * Date range (Fromdate/Todate â€" VendorReturnsSet's own filter names,
       * same Bukrs+Lifnr filter shape as MatReceiptSet). VendorReturnsSet
       * returns one row per goods-return line: Mblnr (material document),
       * Werks (plant), Ebeln (PO number), Bwart (movement type), Menge
       * (quantity), BudatMkpf (posting date â€" note the different casing
       * from MatReceiptSet's Budat_mkpf) â€" counted for "Return items", no
       * amount/chart, same as Material receipts.
       */
      onVendorReturnsPress: function () {
        this._sActiveMdPanel = "vendorreturns"; this._persistUiState();
        var sBukrs = this._sBukrs;
        var sLifnr = this._oReconModel.getProperty("/mdLifnr");
        var sFromDate = this._sKeyDate;

        if (!sBukrs || !sLifnr || !sFromDate) {
          MessageToast.show(
            "Company Code, Supplier and From Date are required.",
          );
          return;
        }

        // _showMdPanel first: it swaps a still-untouched FY-start default
        // To Date over to today, and reading _sKeyDateTo before that swap
        // ran captured the stale FY-start value on the first non-Opening-
        // Balance panel pressed each session (see onTransactionsPress).
        this._showMdPanel("mdShowVendorReturns");
        var sToDate = this._sKeyDateTo || this._sKeyDate;

        var oModel = this.getOwnerComponent().getModel();
        var oReconModel = this._oReconModel;

        // VendorReturnsSet expects Lifnr zero-padded to 10 digits, same as
        // MatReceiptSet/TotalPOSet/LotAcceptSet/VendBalAdvSet.
        var sLifnrPadded = String(sLifnr).padStart(10, "0");
        var aFilters = [
          new Filter("Bukrs", FilterOperator.EQ, sBukrs),
          new Filter("Lifnr", FilterOperator.EQ, sLifnrPadded),
          new Filter("Fromdate", FilterOperator.EQ, new Date(sFromDate)),
          new Filter("Todate", FilterOperator.EQ, new Date(sToDate)),
        ];
        oReconModel.setProperty("/vendorReturnsBusy", true);

        var that = this;

        oModel.read("/VendorReturnsSet", {
          filters: aFilters,
          success: function (oData) {
            var aRawResults = oData.results || [];
            if (aRawResults.length === 0) {
              MessageToast.show("No vendor returns found.");
            }

            var fTotal = 0;
            var aItems = aRawResults.map(function (o) {
              var fMenge = parseFloat(o.Menge) || 0;
              fTotal += fMenge;
              return {
                Mblnr: o.Mblnr,
                Zeile: o.Zeile,
                Werks: o.Werks,
                Bukrs: o.Bukrs,
                Gjahr: o.Gjahr,
                Lifnr: o.Lifnr,
                Ebeln: o.Ebeln,
                Ebelp: o.Ebelp,
                Bwart: o.Bwart,
                Matnr: o.Matnr,
                Maktx: o.Maktx,
                Lgort: o.Lgort,
                Menge: fMenge,
                Meins: o.Meins,
                BudatMkpf: o.BudatMkpf,
              };
            });

            oReconModel.setProperty("/vendorReturnsItems", aItems);
            oReconModel.setProperty("/vendorReturnsTotal", fTotal);
            oReconModel.setProperty("/vendorReturnsCount", aItems.length);
            oReconModel.setProperty(
              "/vendorReturnsSupplierName",
              oReconModel.getProperty("/mdSupplierName") || "",
            );
            oReconModel.setProperty("/vendorReturnsBusy", false);
          },
          error: function () {
            oReconModel.setProperty("/vendorReturnsItems", []);
            oReconModel.setProperty("/vendorReturnsTotal", 0);
            oReconModel.setProperty("/vendorReturnsCount", 0);
            oReconModel.setProperty("/vendorReturnsBusy", false);
            MessageToast.show("Error loading vendor returns.");
          },
        });
      },

      /** Back navigation out of the Vendor returns panel: returns to the Line items view. */
      onBackFromVendorReturns: function () {
        this._oReconModel.setProperty("/mdShowVendorReturns", false);
      },

      /**
       * Fired from the "Pending invoices" row in the master-detail
       * Materials (MM) panel. Calls PendInvValuesSet for the current
       * Company Code / Supplier / To Date (same Bukrs/Lifnr/Budat pattern
       * as Advance balance/Opening balance â€" "value as on <To Date>"), e.g.:
       *   PendInvValuesSet?$filter=Bukrs eq '1000' and Lifnr eq '001000047'
       *   and Budat eq datetime'...'
       * PendInvValuesSet returns Bukrs/Name/Belnr/Lifnr/Umskz/Blart/Budat/
       * Dmbtr/Shkzg â€" no clearing document, so Status just renders the
       * blank/"Open" default like Advance balance/Debit notes.
       */
      onPendingInvoicesPress: function () {
        this._sActiveMdPanel = "pendinginvoices"; this._persistUiState();
        var sBukrs = this._sBukrs;
        var sLifnr = this._oReconModel.getProperty("/mdLifnr");

        if (!sBukrs || !sLifnr || !(this._sKeyDateTo || this._sKeyDate)) {
          MessageToast.show(
            "Company Code, Supplier and From Date are required.",
          );
          return;
        }

        // _showMdPanel first: it swaps a still-untouched FY-start default
        // To Date over to today, and reading _sKeyDateTo before that swap
        // ran captured the stale FY-start value on the first non-Opening-
        // Balance panel pressed each session (see onTransactionsPress).
        this._showMdPanel("mdShowPendingInvoices");
        var sToDate = this._sKeyDateTo || this._sKeyDate;

        var oModel = this.getOwnerComponent().getModel();
        var oReconModel = this._oReconModel;

        // PendInvValuesSet expects Lifnr zero-padded to 10 digits in the
        // filter (e.g. "0001000047"), same as VendBalAdvSet/DebitAmt1Set.
        var sLifnrPadded = String(sLifnr).padStart(10, "0");
        var aFilters = [
          new Filter("Bukrs", FilterOperator.EQ, sBukrs),
          new Filter("Lifnr", FilterOperator.EQ, sLifnrPadded),
          new Filter("Budat", FilterOperator.EQ, new Date(sToDate)),
        ];
        oReconModel.setProperty("/pendingInvoicesBusy", true);

        var that = this;

        oModel.read("/PendInvValuesSet", {
          filters: aFilters,
          success: function (oData) {
            var aRawResults = oData.results || [];
            if (aRawResults.length === 0) {
              MessageToast.show("No pending invoices found.");
            }

            var fTotal = 0;
            var aItems = aRawResults.map(function (o) {
              var fDmbtr = parseFloat(o.Dmbtr) || 0;
              var fSignedAmt = o.Shkzg === "H" ? -fDmbtr : fDmbtr;
              fTotal += fSignedAmt;
              return {
                Belnr: o.Belnr,
                Budat: o.Budat,
                Blart: o.Blart,
                NetAmt: fSignedAmt,
                Bukrs: o.Bukrs,
                Lifnr: o.Lifnr,
                Name1: o.Name,
                Umskz: o.Umskz,
                Shkzg: o.Shkzg,
              };
            });

            that._sortByBudatDesc(aItems);
            oReconModel.setProperty("/pendingInvoicesItems", aItems);
            oReconModel.setProperty("/pendingInvoicesTotal", fTotal);
            oReconModel.setProperty("/pendingInvoicesBusy", false);
          },
          error: function () {
            oReconModel.setProperty("/pendingInvoicesItems", []);
            oReconModel.setProperty("/pendingInvoicesTotal", 0);
            oReconModel.setProperty("/pendingInvoicesBusy", false);
            MessageToast.show("Error loading pending invoices.");
          },
        });
      },

      /** Back navigation out of the Pending invoices panel: returns to the Line items view. */
      onBackFromPendingInvoices: function () {
        this._oReconModel.setProperty("/mdShowPendingInvoices", false);
      },

      /**
       * Fired from the "Payments" row in the master-detail Finance (FI)
       * panel. Calls PmtSelPrdSet directly for the current Company Code /
       * Supplier / date range already loaded on the page (same
       * Bukrs/Lifnr/From-To Date as Opening balance/Transactions â€" no
       * separate date-range dialog), e.g.:
       *   PmtSelPrdSet?$filter=Budat ge datetime'...' and Budat le
       *   datetime'...' and Bukrs eq '1000' and Lifnr eq '6000020'
       * Sums Dmbtr (Shkzg 'H' = credit, subtracted) into the Payments
       * total and switches the right panel into the Payments panel.
       */
     
      onPaymentsRowPress: function () {
        this._sActiveMdPanel = "payments"; this._persistUiState();
        var sBukrs = this._sBukrs;
        var sLifnr = this._oReconModel.getProperty("/mdLifnr");
        var sFromDate = this._sKeyDate;

        if (!sBukrs || !sLifnr || !sFromDate) {
          MessageToast.show(
            "Company Code, Supplier and From Date are required.",
          );
          return;
        }

        // _showMdPanel first: it swaps a still-untouched FY-start default
        // To Date over to today, and reading _sKeyDateTo before that swap
        // ran captured the stale FY-start value on the first non-Opening-
        // Balance panel pressed each session (see onTransactionsPress).
        this._showMdPanel("mdShowPayments");
        var sToDate = this._sKeyDateTo || this._sKeyDate;

        var oModel = this.getOwnerComponent().getModel();
        var oReconModel = this._oReconModel;
        var that = this;

        // PmtSelPrdSet takes the range as two discrete BudatFrom/BudatTo EQ
        // filters (same shape as DebitAmt1Set), not a Budat BT range, and
        // expects Lifnr zero-padded to 10 digits.
        var sLifnrPadded = String(sLifnr).padStart(10, "0");
        var aFilters = [
          new Filter("Bukrs", FilterOperator.EQ, sBukrs),
          new Filter("Lifnr", FilterOperator.EQ, sLifnrPadded),
          new Filter(
            "BudatFrom",
            FilterOperator.EQ,
            this._toUtcMidnight(sFromDate),
          ),
          new Filter(
            "BudatTo",
            FilterOperator.EQ,
            this._toUtcMidnight(sToDate),
          ),
        ];

        var sPeriodLabel =
          this.formatDisplayDate(sFromDate) +
          " - " +
          this.formatDisplayDate(sToDate);

        // Busy indicator flipped synchronously before the read (panel
        // visibility was already switched above, before sToDate was read)
        // so Payments shows its spinner immediately on click instead of
        // only after PmtSelPrdSet's response lands (previously deferred
        // into _showPaymentsPanel, which only ran inside the async
        // success/error callback).
        oReconModel.setProperty("/paymentsBusy", true);

        oModel.read("/PmtSelPrdSet", {
          filters: aFilters,
          success: function (oData) {
            var aResults = oData.results || [];
            console.log("PmtSelPrdSet response:", aResults);

            that._showPaymentsPanel(aResults, sPeriodLabel);
          },
          error: function (oError) {
            console.log("PmtSelPrdSet read failed:", oError);

            // This service raises a business exception (HTTP 400,
            // /IWBEP/CM_MGW_RT/022 "Data is not Found") instead of
            // returning 200 with an empty results array when no rows
            // match the date range â€" treat that specific case as "no
            // payments found" rather than a real error.
            var bNoDataFound = false;
            try {
              var oBody = JSON.parse(oError.responseText);
              bNoDataFound =
                !!oBody.error &&
                oBody.error.code === "/IWBEP/CM_MGW_RT/022";
            } catch (e) {
              bNoDataFound = false;
            }

            if (bNoDataFound) {
              that._showPaymentsPanel([], sPeriodLabel);
              MessageToast.show("No payments found for that period.");
              return;
            }

            oReconModel.setProperty("/paymentsBusy", false);
            MessageToast.show("Error loading payments for that period.");
          },
        });
      },

      /**
       * Builds a Date pinned to UTC midnight for a "yyyy-MM-dd" value, so
       * the OData v2 model's Edm.DateTime serialization always comes out
       * as "yyyy-MM-ddT00:00:00" â€" no milliseconds, no "Z"/offset â€"
       * regardless of the browser's local timezone.
       */
      _toUtcMidnight: function (sYyyyMmDd) {
        var aParts = sYyyyMmDd.split("-").map(Number);
        return new Date(Date.UTC(aParts[0], aParts[1] - 1, aParts[2]));
      },

      /**
       * Maps a PmtSelPrdSet response into the shape the Payments table
       * binds to. Blart is constant ("KZ") across every row here, so
       * Pmttype ("ON_ACCOUNT" / "CLEARED") is carried through instead â€"
       * that's the field that actually distinguishes rows in this
       * response â€" sums the signed total, and switches the master-detail
       * right panel into this Payments view (mdShowPayments).
       */
      _showPaymentsPanel: function (aResults, sPeriodLabel) {
        var that = this;
        var oReconModel = this._oReconModel;

        this._sortByBudatDesc(aResults);
        var aItems = aResults.map(function (o) {
          var fDmbtr = parseFloat(o.Dmbtr) || 0;
          var fSignedAmt = o.Shkzg === "H" ? -fDmbtr : fDmbtr;
          return {
            Belnr: o.Belnr,
            Budat: o.Budat,
            Blart: o.Docty_desc || o.Pmttype || o.Blart,
            NetAmt: fSignedAmt,
            Augbl: o.Augbl,
            PmtCategory: that._categorizePmttype(o.Pmttype || o.Docty_desc || o.Blart),
            Bukrs: o.Bukrs,
            Lifnr: o.Lifnr,
            Name1: o.Name1,
            Sgtxt: o.Sgtxt,
            Rebzg: o.Rebzg,
            Waers: o.Waers,
            Bstat: o.Bstat,
            Bldat: o.Bldat,
            Umskz: o.Umskz,
            Shkzg: o.Shkzg,
          };
        });
        var fTotal = aItems.reduce(function (fSum, o) {
          return fSum + o.NetAmt;
        }, 0);

        oReconModel.setProperty("/paymentsItemsAll", aItems);
        oReconModel.setProperty("/paymentsItems", aItems);
        oReconModel.setProperty("/paymentsTotal", fTotal);
        oReconModel.setProperty("/mdPaymentsPeriodLabel", sPeriodLabel);
        oReconModel.setProperty("/mdPaymentsValue", this.formatBalanceValue(fTotal));
        oReconModel.setProperty("/mdPaymentsSelectedCategory", null);
        oReconModel.setProperty(
          "/paymentsTypeTotals",
          this._computePaymentsTypeTotals(aItems),
        );
        // Panel visibility (mdShowPayments/etc.) is now set synchronously in
        // onPaymentsRowPress before the read, matching every other panel's
        // handler pattern — this function only fills in the fetched data.
        oReconModel.setProperty("/paymentsBusy", false);
      },

      /**
       * Maps a PmtSelPrdSet Pmttype (or its fallbacks) to one of the
       * three fixed payment categories the bar chart and the Payments
       * table filter both key off of. Shared by _showPaymentsPanel (to
       * tag each row) and _computePaymentsTypeTotals (to group them).
       */
      _categorizePmttype: function (sPmttype) {
        var sType = (sPmttype || "").toLowerCase();
        if (sType.indexOf("advance") !== -1) return "advance";
        if (sType.indexOf("partial") !== -1) return "partial";
        if (sType.indexOf("open") !== -1) return "open";
        // "Normal"/"NORMAL"/blank/anything else not matched above.
        return "normal";
      },

      /**
       * Groups the already-categorized Payments items (see
       * _categorizePmttype/PmtCategory) into exactly three fixed
       * categories â€" Normal, Open item, Partial payment â€" always
       * returned in that order (0 when a category has no rows) so the
       * bar chart in the stat-tiles row is always three bars, not a
       * variable-length list. Sums each group's already-signed NetAmt.
       */
      _computePaymentsTypeTotals: function (aItems) {
        var aCategories = [
          { key: "normal", label: "Normal", amount: 0 },
          { key: "open", label: "On Account", amount: 0 },
          { key: "partial", label: "Partial payment", amount: 0 },
          { key: "advance", label: "Advance", amount: 0 },
        ];
        var oByKey = {
          normal: aCategories[0],
          open: aCategories[1],
          partial: aCategories[2],
          advance: aCategories[3],
        };

        (aItems || []).forEach(function (o) {
          oByKey[o.PmtCategory].amount += o.NetAmt;
        });

        return aCategories;
      },

      /**
       * Fired when a bar in the Payments-by-type chart is clicked.
       * Filters /paymentsItems (bound to the Payments table) down to the
       * items in that category â€" same toggle-to-clear behaviour as the
       * monthly chart: clicking the already-active category clears the
       * filter back to the full list.
       */
      _onPaymentsCategorySelected: function (sCategoryKey) {
        var oReconModel = this._oReconModel;
        var sCurrent = oReconModel.getProperty("/mdPaymentsSelectedCategory");
        var aAll = oReconModel.getProperty("/paymentsItemsAll") || [];

        if (sCurrent === sCategoryKey) {
          oReconModel.setProperty("/mdPaymentsSelectedCategory", null);
          oReconModel.setProperty("/paymentsItems", aAll);
          oReconModel.setProperty("/paymentsTotal", this._sumNetAmt(aAll));
        } else {
          var aFiltered = aAll.filter(function (o) {
            return o.PmtCategory === sCategoryKey;
          });
          oReconModel.setProperty("/mdPaymentsSelectedCategory", sCategoryKey);
          oReconModel.setProperty("/paymentsItems", aFiltered);
          oReconModel.setProperty("/paymentsTotal", this._sumNetAmt(aFiltered));
        }

        this._renderPaymentsTypeBarChart(0);
      },

      /** Back button on the Payments panel: returns to the Line items view. */
      onBackToOpenItems: function () {
        this._oReconModel.setProperty("/mdShowPayments", false);
      },

      /**
       * Draws the SVG donut + side legend + top-5 category bars into their
       * plain <div> containers. If the containers aren't mounted yet (the
       * card's "visible" binding hasn't finished flipping true), retries a
       * few times before giving up.
       */
      _renderDonutSvg: function (iAttempt) {
        var that = this;
        iAttempt = iAttempt || 0;

        var oContainer = document.getElementById("donutSvgContainer");
        var oTopCatNamesContainer = document.getElementById(
          "topCategoriesNamesContainer",
        );

        if (!oContainer || !oTopCatNamesContainer) {
          if (iAttempt < 10) {
            setTimeout(function () {
              that._renderDonutSvg(iAttempt + 1);
            }, 100);
          }
          return;
        }

        var oReconModel = this.getView().getModel("recon");
        var aDonut = oReconModel.getProperty("/donut") || [];

        if (!aDonut.length) {
          oContainer.innerHTML = "";
          oTopCatNamesContainer.innerHTML = "";
          return;
        }

        this._renderTopCategories(aDonut, oTopCatNamesContainer);

        var W = 260,
          H = 260,
          CX = W / 2,
          CY = H / 2;
        var R_OUTER = 114,
          R_INNER = 70;

        var fStartAngle = 0;
        var aSlices = [];

        aDonut.forEach(function (o) {
          var fSweep = o.share * 360;
          aSlices.push({
            category: o.category,
            percentLabel: o.percentLabel,
            colorHex: o.colorHex,
            startAngle: fStartAngle,
            endAngle: fStartAngle + fSweep,
            sweep: fSweep,
          });
          fStartAngle += fSweep;
        });

        function polarToCartesian(cx, cy, r, angleDeg) {
          var rad = ((angleDeg - 90) * Math.PI) / 180.0;
          return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
        }

        function describeArc(cx, cy, rOuter, rInner, startAngle, endAngle) {
          var startOuter = polarToCartesian(cx, cy, rOuter, endAngle);
          var endOuter = polarToCartesian(cx, cy, rOuter, startAngle);
          var startInner = polarToCartesian(cx, cy, rInner, endAngle);
          var endInner = polarToCartesian(cx, cy, rInner, startAngle);
          var largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1";

          return [
            "M",
            startOuter.x,
            startOuter.y,
            "A",
            rOuter,
            rOuter,
            0,
            largeArcFlag,
            0,
            endOuter.x,
            endOuter.y,
            "L",
            endInner.x,
            endInner.y,
            "A",
            rInner,
            rInner,
            0,
            largeArcFlag,
            1,
            startInner.x,
            startInner.y,
            "Z",
          ].join(" ");
        }

        var sPathsHtml = "";
        var sLabelsHtml = "";

        aSlices.forEach(function (oSlice, i) {
          var sPath = describeArc(
            CX,
            CY,
            R_OUTER,
            R_INNER,
            oSlice.startAngle,
            oSlice.endAngle,
          );
          sPathsHtml +=
            '<path class="donutSlice" data-donut-index="' +
            i +
            '" d="' +
            sPath +
            '" fill="' +
            oSlice.colorHex +
            '" stroke="#ffffff" stroke-width="3"></path>';

          if (oSlice.sweep >= 6) {
            var fMidAngle = (oSlice.startAngle + oSlice.endAngle) / 2;
            var oLabelPos = polarToCartesian(
              CX,
              CY,
              (R_OUTER + R_INNER) / 2,
              fMidAngle,
            );
            sLabelsHtml +=
              '<text x="' +
              oLabelPos.x +
              '" y="' +
              oLabelPos.y +
              '" text-anchor="middle" dominant-baseline="middle" class="donutSliceLabel">' +
              oSlice.percentLabel +
              "</text>";
          }
        });

        var sSvg =
          '<svg width="100%" height="' +
          H +
          '" viewBox="0 0 ' +
          W +
          " " +
          H +
          '" xmlns="http://www.w3.org/2000/svg">' +
          sPathsHtml +
          sLabelsHtml +
          "</svg>";

        oContainer.innerHTML =
          '<div class="donutSvgWrapper">' +
          sSvg +
          '<div class="donutCenterText">' +
          '<div class="donutCenterLabel">Total Net Amount</div>' +
          '<div class="donutCenterValue">100%</div>' +
          "</div>" +
          "</div>";

        var that3 = this;
        oContainer.querySelectorAll(".donutSlice").forEach(function (oPath) {
          oPath.addEventListener("click", function () {
            var iIndex = parseInt(oPath.getAttribute("data-donut-index"), 10);
            var oDonutItem = aDonut[iIndex];
            if (oDonutItem) {
              that3._onCategorySelected(oDonutItem.akont, oDonutItem.rawTxt50);
            }
          });
        });
      },
      /**
       * Renders the "Top 5 Categories by Net Amount" bar list on the left
       * of the chart tab, sorted by absolute net amount, largest first.
       */
      _renderTopCategories: function (aDonut, oContainer) {
        var that = this;
        var aSorted = aDonut.slice().sort(function (a, b) {
          return b.absNetAmt - a.absNetAmt;
        });
        var fMax = aSorted.length ? aSorted[0].absNetAmt || 1 : 1;

        var sHtml = "";
        aSorted.forEach(function (o, i) {
          var fBarPercent = Math.min(100, (o.absNetAmt / fMax) * 100);
          sHtml +=
            '<div class="topCatRow" data-topcat-index="' +
            i +
            '">' +
            '<div class="topCatHeaderLine">' +
            '<span class="topCatName">' +
            o.category +
            "</span>" +
            '<span class="topCatValue">' +
            that.formatLakh(o.netAmt) +
            ' <span class="topCatPercent">(' +
            o.percentLabel +
            ")</span></span>" +
            "</div>" +
            '<div class="topCatBarTrack">' +
            '<div class="topCatBarFill" style="width:' +
            fBarPercent +
            "%;background:" +
            o.colorHex +
            ';"></div>' +
            "</div>" +
            "</div>";
        });

        oContainer.innerHTML = sHtml;

        oContainer.querySelectorAll(".topCatRow").forEach(function (oRow) {
          oRow.addEventListener("click", function () {
            var iIndex = parseInt(oRow.getAttribute("data-topcat-index"), 10);
            var oCatItem = aSorted[iIndex];
            if (oCatItem) {
              that._onCategorySelected(oCatItem.akont, oCatItem.rawTxt50);
            }
          });
        });
      },

      onCompCodeF4: function () {
        var that = this;
        if (!this._oCompCodeDialog) {
          Fragment.load({
            id: this.getView().getId(),
            name: "supplieropenitems.view.fragment.CompCodeF4",
            controller: this,
          }).then(function (oDialog) {
            that._oCompCodeDialog = oDialog;
            that.getView().addDependent(oDialog);
            that._fetchCompCodes(oDialog);
          });
        } else {
          this._fetchCompCodes(this._oCompCodeDialog);
        }
      },

      _fetchCompCodes: function (oDialog) {
        var oModel = this.getOwnerComponent().getModel();
        var that = this;

        if (!oModel || typeof oModel.read !== "function") {
          oDialog.setBusy(false);
          MessageToast.show("OData service not available. Check connection.");
          return;
        }

        oDialog.setBusy(true);
        oDialog.open();

        oModel.read("/CompCodeF4Set", {
          success: function (oData) {
            oDialog.setBusy(false);
            that.getView().getModel("compCodeModel").setData(oData);
            oDialog.bindAggregation("items", {
              path: "compCodeModel>/results",
              template: new sap.m.StandardListItem({
                title: "{compCodeModel>Bukrs}",
                description: "{compCodeModel>Butxt}",
                type: "Active",
              }),
            });
          },
          error: function () {
            oDialog.setBusy(false);
            MessageToast.show("Error loading company codes.");
          },
        });
      },

      onCompCodeSearch: function (oEvent) {
        var sValue = oEvent.getParameter("value");
        var oFilter = new Filter({
          filters: [
            new Filter("Bukrs", FilterOperator.Contains, sValue),
            new Filter("Butxt", FilterOperator.Contains, sValue),
          ],
          and: false,
        });
        oEvent.getSource().getBinding("items").filter([oFilter]);
      },

      onCompCodeConfirm: function (oEvent) {
        var oSelected = oEvent.getParameter("selectedItem");
        if (oSelected) {
          this.byId("inputBukrs").setValue(oSelected.getTitle());
        }
      },

      onCompCodeDialogClose: function () {
        if (this._oCompCodeDialog) this._oCompCodeDialog.close();
      },

      onSupplierF4: function () {
        var that = this;
        if (!this._oSupplierDialog) {
          Fragment.load({
            id: this.getView().getId(),
            name: "supplieropenitems.view.fragment.SupplierF4",
            controller: this,
          }).then(function (oDialog) {
            that._oSupplierDialog = oDialog;
            that.getView().addDependent(oDialog);
            that._fetchSuppliers(oDialog);
          });
        } else {
          this._fetchSuppliers(this._oSupplierDialog);
        }
      },

      _fetchSuppliers: function (oDialog) {
        var oOData = this.getOwnerComponent().getModel();
        var that = this;
        var sBukrs = this.byId("inputBukrs").getValue().trim();

        oDialog.setBusy(true);
        oDialog.open();

        var aFilters = [];
        if (sBukrs) {
          aFilters.push(new Filter("Bukrs", FilterOperator.EQ, sBukrs));
        }

        oOData.read("/SupplierF4Set", {
          success: function (oData) {
            oDialog.setBusy(false);
            that.getView().getModel("supplierModel").setData(oData);

            // Bind the dialog items aggregation with a fresh template
            oDialog.bindAggregation("items", {
              path: "supplierModel>/results",
              template: new sap.m.StandardListItem({
                title: "{supplierModel>Lifnr}",
                description: "{supplierModel>Name1}",
                type: "Active",
              }),
            });
          },
          error: function () {
            oDialog.setBusy(false);
            MessageToast.show("Error loading suppliers.");
          },
        });
      },

      onSupplierSearch: function (oEvent) {
        var sValue = oEvent.getParameter("value");
        var oFilter = new Filter({
          filters: [
            new Filter("Lifnr", FilterOperator.Contains, sValue),
            new Filter("Name1", FilterOperator.Contains, sValue),
          ],
          and: false,
        });
        oEvent.getSource().getBinding("items").filter([oFilter]);
      },

      onSupplierConfirm: function (oEvent) {
        var oSelected = oEvent.getParameter("selectedItem");
        if (oSelected) {
          this.byId("inputLifnr").setValue(oSelected.getTitle());
        }
      },

      onSupplierDialogClose: function () {
        if (this._oSupplierDialog) this._oSupplierDialog.close();
      },

      // ═══════════════════════════════════════════════════════════════════
      //  QC CHARACTERISTICS FOR LOT NUMBER
      // ═══════════════════════════════════════════════════════════════════

      onLotsReceivedLotNumberPress: function (oEvent) {
        var that = this;
        var oSource = oEvent.getSource();
        var oContext = oSource.getBindingContext("recon");

        if (!oContext) return;

        var oLotData = oContext.getObject();
        var sPrueflos = oLotData.Prueflos;
        var sWerks = oLotData.Werks;
        var sMatnr = oLotData.Matnr;

        if (!sPrueflos || !sWerks || !sMatnr) {
          MessageToast.show("Lot Number, Plant, or Material data is missing.");
          return;
        }

        this._showQcCharacteristicsDialog(sPrueflos, sWerks, sMatnr, oLotData);
      },

      _showQcCharacteristicsDialog: function (
        sPrueflos,
        sWerks,
        sMatnr,
        oLotData,
      ) {
        var that = this;
        var oModel = this.getOwnerComponent().getModel();
        var oReconModel = this.getView().getModel("recon");

        // Set busy state
        oReconModel.setProperty("/qcCharBusy", true);
        oReconModel.setProperty("/qcCharacteristics", []);

        // Destroy previous dialog if it exists
        var oExistingDialog = this.getView().byId("qcCharDialog");
        if (oExistingDialog) {
          oExistingDialog.destroy();
        }

        Fragment.load({
          id: this.getView().getId(),
          name: "supplieropenitems.view.fragment.QcCharacteristicsDialog",
          controller: this,
        }).then(function (oDialog) {
          that.getView().addDependent(oDialog);

          // Update title with lot number
          var oTitle = oDialog.getContent()[0].getItems()[0].getItems()[0];
          oTitle.setText("QC Characteristics - Lot: " + sPrueflos);

          oDialog.open();

          // Fetch QC Characteristics
          var aFilters = [
            new Filter("Zplant", FilterOperator.EQ, sWerks),
            new Filter("Zmatnr", FilterOperator.EQ, sMatnr),
            new Filter("Zinsplot", FilterOperator.EQ, sPrueflos),
          ];

          oModel.read("/QcCharacteristicsSet", {
            filters: aFilters,
            success: function (oData) {
              var aResults = oData.results || [];
              // Filter out empty results (where Zresult is empty)
              var aFiltered = aResults.filter(function (oItem) {
                return oItem.Zresult && oItem.Zresult.trim() !== "";
              });

              if (aFiltered.length === 0) {
                MessageToast.show(
                  "No data found for this lot number (" + sPrueflos + ") for this condition.",
                );
              }

              oReconModel.setProperty("/qcCharacteristics", aFiltered);
              oReconModel.setProperty("/qcCharBusy", false);
            },
            error: function (oError) {
              console.error("Error loading QC Characteristics:", oError);
              MessageToast.show(
                "No data found for this lot number (" + sPrueflos + ") for this condition.",
              );
              oReconModel.setProperty("/qcCharBusy", false);
              oDialog.close();
            },
          });
        });
      },

      onQcCharDialogClose: function () {
        var oDialog = this.getView().byId("qcCharDialog");
        if (oDialog) {
          if (oDialog.isOpen()) {
            oDialog.close();
          }
          // Remove from dependents before destroying
          this.getView().removeDependent(oDialog);
          oDialog.destroy();
        }
      },

      onSobMaterialFilterPress: function () {
        if (!this._oSobMatF4Dialog) {
          Fragment.load({
            id: this.getView().getId(),
            name: "supplieropenitems.view.fragment.MaterialF4Dialog",
            controller: this,
          }).then(function (oDialog) {
            this._oSobMatF4Dialog = oDialog;
            this.getView().addDependent(this._oSobMatF4Dialog);
            this._loadSobMaterialF4DataFromBackend();
            this._oSobMatF4Dialog.open();
          }.bind(this));
        } else {
          this._loadSobMaterialF4DataFromBackend();
          this._oSobMatF4Dialog.open();
        }
      },

      _loadSobMaterialF4DataFromBackend: function () {
        var oModel = this.getView().getModel();
        var oReconModel = this.getView().getModel("recon");

        if (!oModel) {
          MessageToast.show("OData model not available");
          return;
        }

        var sLifnr = this._sLifnr || "";
        var sBudatFrom = this._sKeyDate || "";
        var sBudatTo = this._sKeyDateTo || "";

        oReconModel.setProperty("/matF4Busy", true);
        oReconModel.setProperty("/matF4Items", []);
        this._aAllMaterialsF4 = [];

        var aFilters = [];
        if (sLifnr) {
          aFilters.push(new Filter("Lifnr", FilterOperator.EQ, sLifnr));
        }
        if (sBudatFrom) {
          aFilters.push(new Filter("BudatFrom", FilterOperator.EQ, new Date(sBudatFrom)));
        }
        if (sBudatTo) {
          aFilters.push(new Filter("BudatTo", FilterOperator.EQ, new Date(sBudatTo)));
        }

        oModel.read("/MatF4TotShareSet", {
          filters: aFilters,
          success: function (oData) {
            if (oData && oData.results) {
              var oMatnrMap = {};
              var aItems = [];

              oData.results.forEach(function (item) {
                if (!oMatnrMap[item.Matnr]) {
                  oMatnrMap[item.Matnr] = true;
                  aItems.push({
                    Matnr: item.Matnr || "",
                    Maktx: item.Maktx || "",
                    Lifnr: item.Lifnr || ""
                  });
                }
              });

              oReconModel.setProperty("/matF4Items", aItems);
              this._aAllMaterialsF4 = aItems;
            }
            oReconModel.setProperty("/matF4Busy", false);
          }.bind(this),
          error: function (oError) {
            MessageToast.show("Error loading materials: " + (oError.message || "Unknown error"));
            oReconModel.setProperty("/matF4Busy", false);
          }.bind(this)
        });
      },

      onSobMaterialF4Search: function (oEvent) {
        var sSearchValue = oEvent.getSource().getValue().toLowerCase();
        var oReconModel = this.getView().getModel("recon");

        var aFilteredItems = this._aAllMaterialsF4.filter(function (item) {
          return (
            (item.Matnr || "").toLowerCase().includes(sSearchValue) ||
            (item.Maktx || "").toLowerCase().includes(sSearchValue)
          );
        });

        oReconModel.setProperty("/matF4Items", aFilteredItems);
      },

      onSobMaterialF4RowSelect: function () {
        // Row selection handled in confirm button
      },

      onSobMaterialF4Confirm: function () {
        var oTable = this.getView().byId("sobMaterialF4Table");
        var aSelectedIndices = oTable.getSelectedIndices();

        if (aSelectedIndices.length === 0) {
          MessageToast.show("Please select at least one material");
          return;
        }

        var oReconModel = this.getView().getModel("recon");
        var aItems = oReconModel.getProperty("/matF4Items");
        var aSelectedMaterials = [];
        var aSelectedMatnrs = [];

        aSelectedIndices.forEach(function (iIndex) {
          var oItem = aItems[iIndex];
          if (oItem) {
            aSelectedMaterials.push(oItem.Matnr);
            aSelectedMatnrs.push(oItem.Matnr);
          }
        });

        oReconModel.setProperty("/sobSelectedMaterials", aSelectedMaterials);

        // Load filtered data from API for selected materials
        this._loadTotalShareBusinessBreakdownFiltered(aSelectedMatnrs);

        var sMatnrList = aSelectedMaterials.join(", ");
        MessageToast.show("Loading data for material(s): " + sMatnrList);
        this.onSobMaterialF4CancelDialog();
      },

      onSobMaterialF4CancelDialog: function () {
        if (this._oShareOfBusinessMatF4Dialog) {
          this._oShareOfBusinessMatF4Dialog.close();
        }
        if (this._oSobMatF4Dialog) {
          this._oSobMatF4Dialog.close();
        }
      },

      onMaterialF4Cancel: function () {
        this.onSobMaterialF4CancelDialog();
      },

      onShareOfBusinessMaterialFilterPress: function () {
        if (!this._oShareOfBusinessMatF4Dialog) {
          Fragment.load({
            id: this.getView().getId(),
            name: "supplieropenitems.view.fragment.MaterialF4Dialog",
            controller: this,
          }).then(function (oDialog) {
            this._oShareOfBusinessMatF4Dialog = oDialog;
            this.getView().addDependent(this._oShareOfBusinessMatF4Dialog);
            this._loadShareOfBusinessMaterialF4Data();
            this._oShareOfBusinessMatF4Dialog.open();
          }.bind(this));
        } else {
          this._loadShareOfBusinessMaterialF4Data();
          this._oShareOfBusinessMatF4Dialog.open();
        }
      },

      _loadShareOfBusinessMaterialF4Data: function () {
        var oModel = this.getView().getModel();
        var oReconModel = this.getView().getModel("recon");

        if (!oModel) {
          MessageToast.show("OData model not available");
          return;
        }

        var sLifnr = this._sLifnr || "";
        var sBudatFrom = this._sKeyDate || "";
        var sBudatTo = this._sKeyDateTo || "";

        oReconModel.setProperty("/matF4Busy", true);
        oReconModel.setProperty("/matF4Items", []);
        this._aShareOfBusinessMaterialsF4 = [];

        var aFilters = [];
        if (sLifnr) {
          aFilters.push(new Filter("Lifnr", FilterOperator.EQ, sLifnr));
        }
        if (sBudatFrom) {
          aFilters.push(new Filter("BudatFrom", FilterOperator.EQ, new Date(sBudatFrom)));
        }
        if (sBudatTo) {
          aFilters.push(new Filter("BudatTo", FilterOperator.EQ, new Date(sBudatTo)));
        }

        var that = this;

        oModel.read("/MatF4TotShareSet", {
          filters: aFilters,
          success: function (oData) {
            if (oData && oData.results) {
              var oMatnrMap = {};
              var aItems = [];

              oData.results.forEach(function (item) {
                if (!oMatnrMap[item.Matnr]) {
                  oMatnrMap[item.Matnr] = true;
                  aItems.push({
                    Matnr: item.Matnr || "",
                    Maktx: item.Maktx || "",
                    Lifnr: item.Lifnr || ""
                  });
                }
              });

              oReconModel.setProperty("/matF4Items", aItems);
              that._aShareOfBusinessMaterialsF4 = aItems;

              // Select rows for already-selected materials
              setTimeout(function () {
                that._preselectMaterialsInDialog(aItems);
              }, 100);
            }
            oReconModel.setProperty("/matF4Busy", false);
          },
          error: function (oError) {
            MessageToast.show("Error loading materials: " + (oError.message || "Unknown error"));
            oReconModel.setProperty("/matF4Busy", false);
          }
        });
      },

      _preselectMaterialsInDialog: function (aItems) {
        var oTable = this.getView().byId("sobMaterialF4Table");
        if (!oTable) {
          return;
        }

        var oReconModel = this.getView().getModel("recon");
        var aSelectedMaterials = oReconModel.getProperty("/sobSelectedMaterials") || [];

        // Clear previous selections
        oTable.clearSelection();

        // Select rows that match already-selected materials
        if (aSelectedMaterials && aSelectedMaterials.length > 0) {
          aItems.forEach(function (item, index) {
            if (aSelectedMaterials.indexOf(item.Matnr) >= 0) {
              oTable.addSelectionInterval(index, index);
            }
          });
        }
      },

    });
  },
);
