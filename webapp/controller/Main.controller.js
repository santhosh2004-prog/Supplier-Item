sap.ui.define(
  [
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "sap/ui/core/Fragment",
  ],
  function (
    Controller,
    Filter,
    FilterOperator,
    JSONModel,
    MessageToast,
    MessageBox,
    Fragment,
  ) {
    "use strict";

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

    return Controller.extend("supplieropenitems.controller.main", {
      onInit: function () {
        this._oReconModel = new JSONModel({
          items: [],
          donut: [],
          count: 0,
          busy: false,
          masterDetailMode: false,
          openingBalanceValue: 0,
          mdPaymentsValue: "₹45.6L",
          mdVsPriorPercent: null,
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
        // start of the current financial year (1 April — e.g. today in
        // Jan-Mar 2026 means FY start is 01.04.2025, not 01.04.2026), and
        // To Date = today, then run the same search Go would — the fields
        // stay fully editable, this just saves the user the first Go click
        // on every fresh page load.
        var oToday = new Date();
        var sToday = this._toIsoDate(oToday);

        var iFyStartYear =
          oToday.getMonth() >= 3 // getMonth() is 0-based; 3 = April
            ? oToday.getFullYear()
            : oToday.getFullYear() - 1;
        var sFyStart = this._toIsoDate(new Date(iFyStartYear, 3, 1));

        this.byId("inputBukrs").setValue("1000");
        this.byId("inputKeyDate").setValue(sFyStart);
        this.byId("inputKeyDateTo").setValue(sToday);

        // Remembers which Finance/Materials row is currently open in the
        // master-detail right panel ("opening" | "transactions" | "advance"
        // | "debitnotes" | "payments" | "generic"), so that re-running the
        // search with new dates (Go) re-loads the SAME panel instead of
        // silently dropping back to Opening balance. Only a fresh page load
        // (this initial value) defaults to Opening balance.
        this._sActiveMdPanel = "opening";
        this._sActiveMdPanelLabel = "";

        // Column Settings / Select Layout for the Opening balance "Line
        // items" grid table (masterDetailTable) — same picker+reorder+save
        // flow as any backend-backed layout feature, just backed by
        // localStorage instead of an OData LayoutSet (this app has none).
        this._oiColumnMap = [
          { id: "oiCol1", label: "Document" },
          { id: "oiCol2", label: "Date" },
          { id: "oiCol3", label: "Type" },
          { id: "oiCol4", label: "Amount" },
          { id: "oiCol5", label: "Status" },
        ];
        this.getView().setModel(
          new JSONModel({ columns: this._oiColumnMap }),
          "oiColumnModel",
        );
        this._oiSavedLayouts = [];
        this._loadOpenItemsSavedLayouts();
        this._applyDefaultOpenItemsLayout();

        this.onSearch();
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
       * Fired from the back button on the master-detail (Supplier) panel.
       * Clears the Supplier field and re-runs the search, which drops the
       * page back into the Chart view for the current Company Code/dates.
       */
      onBackToChart: function () {
        this.byId("inputLifnr").setValue("");
        this._sActiveMdPanel = "opening";
        this._sActiveMdPanelLabel = "";
        this.onSearch();
      },

      /**
       * Toggles the docked Finance/Materials/Quality "Modules" sidebar next
       * to the master-detail panel — Gmail-style: pinned open by default,
       * pressing "Modules" collapses it in place (rather than floating a
       * popover over the content), so the right-hand panel (chart + line
       * items) reflows to fill the freed width.
       */
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
        this._sActiveMdPanel = "opening";
        var sBukrs = this._sBukrs;
        var sLifnr = this._oReconModel.getProperty("/mdLifnr");
        // OpBalAsOnSet is "balance as on <date>" — that date is the To
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
        oReconModel.setProperty("/mdShowTransactions", false);
        oReconModel.setProperty("/mdShowPayments", false);
        oReconModel.setProperty("/mdShowGenericModule", false);
        oReconModel.setProperty("/mdShowAdvance", false);
        oReconModel.setProperty("/mdShowDebitNotes", false);

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
                // into the backend) — not "Docty_desc" like the other
                // entity sets. Confirmed against a live OpBalAsOnSet
                // response.
                Blart: o.Docty_dese || o.Blart,
                NetAmt: fSignedAmt,
                Augbl: o.Augdt,
              };
            });

            oReconModel.setProperty("/openItems", aItems);
            oReconModel.setProperty("/openingBalanceValue", fBalance);
            oReconModel.setProperty("/openItemsBusy", false);
          },
          error: function (oError) {
            // Same "Data is not Found" business exception handled in
            // _loadSupplierMasterDetail — treat as no data, not a real error.
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
        // resolved a name (see _loadSupplierMasterDetail) — only the code
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
        if (!sKeyDate) {
          MessageToast.show("Please enter a From Date.");
          return;
        }
        if (sKeyDateTo && new Date(sKeyDateTo) < new Date(sKeyDate)) {
          MessageToast.show("To Date cannot be before From Date.");
          return;
        }

        this._sBukrs = sBukrs;
        this._sKeyDate = sKeyDate;
        this._sKeyDateTo = sKeyDateTo || null;
        this._sSelectedAkont = null;

        // A Supplier NO alongside the Company Code + date range switches the
        // page into the master-detail layout (Finance/Materials/Quality panel
        // + line items) instead of the category donut/chart dashboard.
        if (sLifnr) {
          this._loadSupplierMasterDetail(sBukrs, sLifnr, sKeyDate, sKeyDateTo);
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
       * (dummy data — no backend for these yet) and the real line items
       * table on the right. Both the "Balance value" tile and the Line
       * items table are driven entirely by OpBalAsOnSet — OpenItemsSet is
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
          mdPaymentsValue: "₹45.6L",
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

        // OpBalAsOnSet is "balance as on <date>" — that date is the To
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
            // name resolves, instead of leaving the bare numeric code —
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
                // into the backend) — not "Docty_desc" like the other
                // entity sets. Confirmed against a live OpBalAsOnSet
                // response.
                Blart: o.Docty_dese || o.Blart,
                NetAmt: fSignedAmt,
                Augbl: o.Augdt,
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
          },
          error: function (oError) {
            // Same as PmtSelPrdSet: the backend raises a business exception
            // (HTTP 400, /IWBEP/CM_MGW_RT/022 "Data is not Found") instead of
            // returning 200 with an empty results array when this supplier
            // simply has no opening balance items for the date — treat that
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
        // row was already open — e.g. a user on Payments who only changes
        // From/To Date and presses Go stays on Payments with the new date
        // range, instead of silently being dropped back to Opening balance.
        // Opening balance itself is already covered by the OpBalAsOnSet read
        // above, and "opening" is also the default on a fresh page load.
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
          case "payments":
            this.onPaymentsRowPress();
            break;
          case "generic":
            oReconModel.setProperty("/mdShowPayments", false);
            oReconModel.setProperty("/mdShowTransactions", false);
            oReconModel.setProperty("/mdShowAdvance", false);
            oReconModel.setProperty("/mdShowDebitNotes", false);
            oReconModel.setProperty("/mdShowGenericModule", true);
            oReconModel.setProperty(
              "/mdGenericModuleLabel",
              this._sActiveMdPanelLabel || "",
            );
            break;
          // "opening" (or unset): nothing else to do.
        }

        // Pre-load Transactions / Advance balance / Debit notes / Payments
        // totals for this supplier + date range right away (in parallel with
        // everything above), so the Finance (FI) sidebar rows show each
        // section's amount up front instead of only after that row is
        // clicked. Opening balance's own total is already covered by the
        // OpBalAsOnSet read above (/openingBalanceValue). Whichever panel is
        // actually active (handled by the switch above) still re-fetches and
        // overwrites its own total with the freshest data, so there's no
        // conflict — this just fills in the other four rows too.
        this._loadSidebarTotals(sBukrs, sLifnr, sKeyDate, sKeyDateTo);
      },

      /**
       * Calls transactionperiodSet / VendBalAdvSet / DebitAmt1Set /
       * PmtSelPrdSet for the current Company Code/Supplier/date range and
       * stores each one's total into the same model properties their own
       * panels already read (/transactionsTotal, /advanceTotal,
       * /debitNotesTotal, /paymentsTotal) — used to populate the amount
       * shown next to each Finance (FI) sidebar row without requiring the
       * user to click into every section first.
       */
      _loadSidebarTotals: function (sBukrs, sLifnr, sKeyDate, sKeyDateTo) {
        var oModel = this.getOwnerComponent().getModel();
        var oReconModel = this._oReconModel;
        var sToDate = sKeyDateTo || sKeyDate;
        var sLifnrPadded = String(sLifnr).padStart(10, "0");

        /** Dmbtr signed by Shkzg ("H" = credit, subtracted), same convention as every other panel here. */
        function sumSigned(aResults) {
          return (aResults || []).reduce(function (fSum, o) {
            var fDmbtr = parseFloat(o.Dmbtr) || 0;
            return fSum + (o.Shkzg === "H" ? -fDmbtr : fDmbtr);
          }, 0);
        }

        // Transactions
        var aTxnFilters = [
          new Filter("Bukrs", FilterOperator.EQ, sBukrs),
          new Filter("Lifnr", FilterOperator.EQ, sLifnr),
          new Filter("FromDate", FilterOperator.EQ, new Date(sKeyDate)),
        ];
        if (sKeyDateTo) {
          aTxnFilters.push(
            new Filter("ToDate", FilterOperator.EQ, new Date(sKeyDateTo)),
          );
        }
        oModel.read("/transactionperiodSet", {
          filters: aTxnFilters,
          success: function (oData) {
            oReconModel.setProperty(
              "/transactionsTotal",
              sumSigned(oData.results),
            );
          },
          error: function () {
            oReconModel.setProperty("/transactionsTotal", 0);
          },
        });

        // Advance balance
        oModel.read("/VendBalAdvSet", {
          filters: [
            new Filter("Bukrs", FilterOperator.EQ, sBukrs),
            new Filter("Lifnr", FilterOperator.EQ, sLifnrPadded),
            new Filter("Budat", FilterOperator.EQ, new Date(sKeyDate)),
          ],
          success: function (oData) {
            oReconModel.setProperty("/advanceTotal", sumSigned(oData.results));
          },
          error: function () {
            oReconModel.setProperty("/advanceTotal", 0);
          },
        });

        // Debit notes — DebitAmt1Set's Dmbtr is already a plain positive
        // amount (no Shkzg sign to apply), same as onDebitNotesPress.
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
          },
          error: function () {
            oReconModel.setProperty("/debitNotesTotal", 0);
          },
        });

        // Payments — PmtSelPrdSet raises a business exception (HTTP 400,
        // /IWBEP/CM_MGW_RT/022 "Data is not Found") instead of an empty
        // result when nothing matches the range; treat that the same as
        // onPaymentsRowPress does — zero, not an error.
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
          },
          error: function () {
            oReconModel.setProperty("/paymentsTotal", 0);
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
        this._sActiveMdPanel = "opening";
        this._sActiveMdPanelLabel = "";
        this._loadSupplierMasterDetail(
          this._sBukrs,
          sLifnr,
          this._sKeyDate,
          this._sKeyDateTo,
        );
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
       * Documents" buckets, totalling Invoice Amt and Net Amt for each — the
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

        this._oReconModel.setProperty("/filteredOpenItems", aFiltered);
        this._oReconModel.setProperty(
          "/filteredOpenItemsTitle",
          sDocType === "RE" ? "RE Documents" : "Non-RE Documents",
        );

        if (!this._oOpenItemsDetailDialog) {
          Fragment.load({
            id: this.getView().getId(),
            name: "supplieropenitems.view.fragment.Openitemsdetail",
            controller: this,
          }).then(function (oDialog) {
            that._oOpenItemsDetailDialog = oDialog;
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

      // ═══════════════════════════════════════════════════════════════════
      // Column Settings / Select Layout — shared across EVERY master-detail
      // line-items grid (Opening balance/masterDetailTable, Transactions,
      // Advance balance, Debit notes, Payments): all five tables render the
      // same 5-column schema (Document/Date/Type/Amount/Status — oiCol1..5,
      // via bindings recon>Belnr/Budat/Blart/NetAmt/Augbl that already exist
      // on every one of those row shapes), so one Column Settings dialog and
      // one Select Layout dialog can drive all five at once. Applying or
      // saving a layout broadcasts the same column order/visibility to every
      // table in OI_TABLE_IDS in one go — that's the "same layout for all"
      // behavior. (Advance balance has no clearing document and Debit notes
      // has neither a posting date nor a clearing document, so Status/Date
      // just render blank/"Open" defaults there if included — still a
      // consistent column set, just not always meaningful data.)
      //
      // Same picker → apply → offer-to-save flow as any backend-backed
      // layout feature; this persists to localStorage (key
      // OI_LAYOUTS_STORAGE_KEY) since there's no LayoutSet OData service in
      // this app.
      // ═══════════════════════════════════════════════════════════════════

      OI_TABLE_IDS: [
        "masterDetailTable",
        "transactionsTable",
        "advanceTable",
        "debitNotesTable",
        "paymentsTable",
      ],

      /** Opens the Column Settings dialog, pre-selecting whichever columns are currently visible on the table whose button was pressed. */
      onLineItemsColumnSettingsPress: function (oEvent) {
        var oView = this.getView();
        var that = this;
        this._sActiveOiTableId =
          oEvent.getSource().data("tableId") || "masterDetailTable";

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

      /** Reads the checked items off oiColumnSelectorList in their current visual order — [{key, title}]. */
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

        this._applyColumnSelectionToAllTables(aSelectedKeys);

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

      /** column id -> the actual cell control template used inside masterDetailTable — mirrors the fixed columns further up this file. */
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
          default:
            return new sap.m.Text({ text: "" });
        }
      },

      /**
       * Rebuilds ONE table's columns (sap.ui.table.Table, NOT
       * sap.ui.table.TreeTable — a plain grid table) from a selected+ordered
       * list of column ids: destroys every column and re-adds them in that
       * order, each carrying its own bound cell template. Rows stay bound to
       * whatever that table's own "rows" aggregation already points at
       * (recon>/openItems, recon>/transactionItems, …) throughout — only the
       * columns aggregation changes.
       *
       * Widths are split evenly as percentages (100 / column count) rather
       * than fixed rem values, so the table's columns always stretch to
       * fill the full width of its containing HBox/VBox — whether that's 3
       * columns or 5 — instead of leaving a blank gap on wide screens or
       * needing a horizontal scrollbar on narrow ones.
       */
      _applyOpenItemsColumnSelection: function (sTableId, aSelectedColumnIds) {
        var oTable = this.byId(sTableId);
        if (!oTable) return;
        var that = this;
        var sWidth = (100 / aSelectedColumnIds.length).toFixed(2) + "%";

        oTable.destroyColumns();

        aSelectedColumnIds.forEach(function (sColId) {
          var oColumn = new sap.ui.table.Column({
            width: sWidth,
            hAlign: sColId === "oiCol4" || sColId === "oiCol5" ? "End" : "Begin",
            label: new sap.m.Label({
              text: that._getOpenItemsColumnLabelById(sColId),
              design: "Bold",
            }),
            template: that._getOpenItemsCellByColumnId(sColId),
          });
          oColumn.data("colId", sColId);
          oTable.addColumn(oColumn);
        });
      },

      /**
       * Broadcasts a column selection+order to EVERY master-detail line-items
       * table (OI_TABLE_IDS) — this is what makes "select/save a layout"
       * apply the same layout everywhere instead of just the panel the
       * dialog happened to be opened from.
       */
      _applyColumnSelectionToAllTables: function (aSelectedColumnIds) {
        var that = this;
        this.OI_TABLE_IDS.forEach(function (sTableId) {
          that._applyOpenItemsColumnSelection(sTableId, aSelectedColumnIds);
        });
      },

      // ─── Select Layout (localStorage-backed) ─────────────────────────────

      OI_LAYOUTS_STORAGE_KEY: "mdOpenItemsSavedLayouts",

      /** Reads saved layouts [{LayoutName, Columns, Default}] from localStorage into oiLayoutModel. */
      _loadOpenItemsSavedLayouts: function () {
        var aLayouts = [];
        try {
          aLayouts =
            JSON.parse(localStorage.getItem(this.OI_LAYOUTS_STORAGE_KEY)) ||
            [];
        } catch (e) {
          aLayouts = [];
        }
        this._oiSavedLayouts = aLayouts;
        this.getView().setModel(
          new JSONModel({ layouts: aLayouts }),
          "oiLayoutModel",
        );
      },

      _saveOpenItemsLayoutsToStorage: function () {
        localStorage.setItem(
          this.OI_LAYOUTS_STORAGE_KEY,
          JSON.stringify(this._oiSavedLayouts),
        );
      },

      /** Applies whichever saved layout has Default:true, if any, to every table — called once on page load. */
      _applyDefaultOpenItemsLayout: function () {
        var oDefault = (this._oiSavedLayouts || []).find(function (o) {
          return o.Default;
        });
        if (!oDefault) return;
        this._applyColumnSelectionToAllTables(oDefault.Columns.split(","));
      },

      onLineItemsLayoutDialogPress: function (oEvent) {
        var oView = this.getView();
        var that = this;
        this._sActiveOiTableId =
          oEvent.getSource().data("tableId") || "masterDetailTable";

        if (!this._oOiLayoutDialog) {
          Fragment.load({
            id: oView.getId(),
            name: "supplieropenitems.view.fragment.OpenItemsLayoutDialog",
            controller: this,
          }).then(function (oDialog) {
            that._oOiLayoutDialog = oDialog;
            oView.addDependent(oDialog);
            oDialog.open();
          });
        } else {
          this._oOiLayoutDialog.open();
        }
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

        this._applyColumnSelectionToAllTables(oSelected.Columns.split(","));
        MessageToast.show(
          "Applied layout to all sections: " + oSelected.LayoutName,
        );

        if (bSetAsDefault) {
          this._oiSavedLayouts.forEach(function (o) {
            o.Default = o.LayoutName === oSelected.LayoutName;
          });
          this._saveOpenItemsLayoutsToStorage();
          MessageToast.show("Layout marked as default.");
        }

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

        this._oiSavedLayouts = this._oiSavedLayouts.filter(function (o) {
          return o.LayoutName !== sLayoutName;
        });
        this._saveOpenItemsLayoutsToStorage();
        this.getView()
          .getModel("oiLayoutModel")
          .setProperty("/layouts", this._oiSavedLayouts);
        MessageToast.show("Layout deleted.");
      },

      /** Formatter for the read-only "Default?" checkbox in the layout table. */
      isOpenItemsDefaultChecked: function (vValue) {
        return !!vValue;
      },

      /**
       * Prompts to save the just-applied column selection as a named,
       * reusable layout — same "Do you want to save this Layout?" step the
       * reference app shows right after Column Settings is confirmed.
       */
      _showSaveOpenItemsLayoutDialog: function (aSelectedKeys) {
        var that = this;

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
                var iExistingIndex = that._oiSavedLayouts.findIndex(
                  function (o) {
                    return o.LayoutName.toUpperCase() === sNameUpper;
                  },
                );

                var fnSave = function () {
                  if (bDefault) {
                    that._oiSavedLayouts.forEach(function (o) {
                      o.Default = false;
                    });
                  }
                  var oPayload = {
                    LayoutName: sNameUpper,
                    Columns: aSelectedKeys.join(","),
                    Default: bDefault,
                  };
                  if (iExistingIndex > -1) {
                    that._oiSavedLayouts[iExistingIndex] = oPayload;
                    MessageToast.show("Layout updated: " + sNameUpper);
                  } else {
                    that._oiSavedLayouts.push(oPayload);
                    MessageToast.show("Layout saved: " + sNameUpper);
                  }
                  that._saveOpenItemsLayoutsToStorage();
                  that.getView()
                    .getModel("oiLayoutModel")
                    .setProperty("/layouts", that._oiSavedLayouts);
                  that._oOiSaveLayoutDialog.close();
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
      formatLakh: function (fValue) {
        var fNum = parseFloat(fValue) || 0;
        var sSign = fNum < 0 ? "-" : "";
        var fAbs = Math.abs(fNum);

        if (fAbs >= 1e7) {
          return (
            sSign +
            (fAbs / 1e7).toLocaleString("en-IN", { maximumFractionDigits: 2 }) +
            " Cr"
          );
        }
        if (fAbs >= 1e5) {
          return (
            sSign +
            (fAbs / 1e5).toLocaleString("en-IN", { maximumFractionDigits: 2 }) +
            " L"
          );
        }
        return (
          sSign + fAbs.toLocaleString("en-IN", { maximumFractionDigits: 2 })
        );
      },

      /**
       * Compact "₹<n> Cr/L/K" amount used for the Finance (FI) sidebar rows —
       * these sit in a narrow column next to the row label, so the full
       * formatBalanceValue figure (e.g. "₹45,24,42,936") wraps/overflows;
       * this collapses it to Crore/Lakh/Thousand the same way formatLakh
       * already does for the Top Categories list, just with a ₹ prefix and
       * an extra "K" tier for values under a lakh.
       */
      formatSidebarAmount: function (fValue) {
        var fNum = parseFloat(fValue) || 0;
        var sSign = fNum < 0 ? "-" : "";
        var fAbs = Math.abs(fNum);

        if (fAbs >= 1e7) {
          return (
            
            sSign +
            (fAbs / 1e7).toLocaleString("en-IN", { maximumFractionDigits: 2 }) +
            " Cr"
          );
        }
        if (fAbs >= 1e5) {
          return (
           
            sSign +
            (fAbs / 1e5).toLocaleString("en-IN", { maximumFractionDigits: 2 }) +
            " L"
          );
        }
        if (fAbs >= 1e3) {
          return (
            
            sSign +
            (fAbs / 1e3).toLocaleString("en-IN", { maximumFractionDigits: 2 }) +
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
          "₹" +
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
       * comma-formatted figures — and mis-truncates value strings that mix
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
        // total (sign included) — pick the most decimals that still fit
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

      /**
       * Draws the "Normal / Open item / Partial payment" chart that sits
       * as its own tile inside the Payments panel's stat-tiles row
       * (mdStatTilesRow) — one horizontal bar per category
       * (.mdHBarRow/.mdHBar/.mdHBarTrack), sourced from
       * /paymentsTypeTotals (same 3 fixed categories every time).
       * Clicking a bar filters the Payments table below down to that
       * category (toggle-to-clear, same as the monthly chart's month
       * bars) — see _onPaymentsCategorySelected.
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
       * Refresh button in the master-detail header: re-runs the current
       * Company Code/Supplier/date-range search, which reloads
       * OpenItemsSet from scratch and — via _loadSupplierMasterDetail —
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
       * (/openItemsAll — unfiltered by any month click), oldest to newest.
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
          // entered) — e.g. To Date = 28.02.2025 draws Mar 2024 through
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
       * (the searched "From Date") — e.g. anchor 28.02.2025 gives Sep 2024,
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
       * searched — unlike the Opening balance chart's fixed 12-month
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
       * recent month and "prior" to the one before it — i.e. by default it
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
       * Opens the "Payments — Select Period" dialog (fires from clicking
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
        this._sActiveMdPanel = "transactions";
        var sBukrs = this._sBukrs;
        var sLifnr = this._oReconModel.getProperty("/mdLifnr");
        var sFromDate = this._sKeyDate;
        var sToDate = this._sKeyDateTo;

        if (!sBukrs || !sLifnr || !sFromDate) {
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
          new Filter("FromDate", FilterOperator.EQ, new Date(sFromDate)),
        ];

        // Only constrain by ToDate when the user actually picked one —
        // when it's empty, the read should be From Date onward, not
        // silently reusing FromDate as both ends of the range.
        if (sToDate) {
          aFilters.push(
            new Filter("ToDate", FilterOperator.EQ, new Date(sToDate)),
          );
        }

        oReconModel.setProperty("/mdShowPayments", false);
        oReconModel.setProperty("/mdShowTransactions", true);
        oReconModel.setProperty("/mdShowGenericModule", false);
        oReconModel.setProperty("/mdShowAdvance", false);
        oReconModel.setProperty("/mdShowDebitNotes", false);
        oReconModel.setProperty("/mdSelectedMonthLabel", "");
        oReconModel.setProperty("/transactionsBusy", true);

        var that = this;

        oModel.read("/transactionperiodSet", {
          filters: aFilters,
         
          success: function (oData) {
            var aRawResults = oData.results || [];
            console.log("transactionperiodSet response:", aRawResults);

            // transactionperiodSet uses lower-case "budat"/"Augdt" (unlike
            // OpenItemsSet/OpBalAsOnSet's "Budat"/"Augbl") — normalize into
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

        this._sActiveMdPanel = "generic";
        this._sActiveMdPanelLabel = sLabel;

        oReconModel.setProperty("/mdShowPayments", false);
        oReconModel.setProperty("/mdShowTransactions", false);
        oReconModel.setProperty("/mdShowAdvance", false);
        oReconModel.setProperty("/mdShowDebitNotes", false);
        oReconModel.setProperty("/mdShowGenericModule", true);
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
        this._sActiveMdPanel = "advance";
        var sBukrs = this._sBukrs;
        var sLifnr = this._oReconModel.getProperty("/mdLifnr");
        var sKeyDate = this._sKeyDate;

        if (!sBukrs || !sLifnr || !sKeyDate) {
          MessageToast.show(
            "Company Code, Supplier and From Date are required.",
          );
          return;
        }

        var oModel = this.getOwnerComponent().getModel();
        var oReconModel = this._oReconModel;

        // VendBalAdvSet expects Lifnr zero-padded to 10 digits in the filter
        // (e.g. "0001000047"), unlike OpBalAsOnSet/transactionperiodSet which
        // take it as entered — pad here the same way _onCategorySelected
        // pads Akont for VENDERSet.
        var sLifnrPadded = String(sLifnr).padStart(10, "0");
        var aFilters = [
          new Filter("Bukrs", FilterOperator.EQ, sBukrs),
          new Filter("Lifnr", FilterOperator.EQ, sLifnrPadded),
          new Filter("Budat", FilterOperator.EQ, new Date(sKeyDate)),
        ];

        oReconModel.setProperty("/mdShowPayments", false);
        oReconModel.setProperty("/mdShowTransactions", false);
        oReconModel.setProperty("/mdShowGenericModule", false);
        oReconModel.setProperty("/mdShowDebitNotes", false);
        oReconModel.setProperty("/mdShowAdvance", true);
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
       * over the searched From/To Date range (BudatFrom/BudatTo, both EQ —
       * this service takes the range as two discrete filter values rather
       * than a Budat BT like Payments), e.g.:
       *   DebitAmt1Set?$filter=Bukrs eq '1000' and Lifnr eq '0001000481'
       *   and BudatFrom eq datetime'...' and BudatTo eq datetime'...'
       * DebitAmt1Set returns Dmbtr already as a plain positive amount (no
       * Shkzg sign to apply) and no per-row posting date.
       */
      onDebitNotesPress: function () {
        this._sActiveMdPanel = "debitnotes";
        var sBukrs = this._sBukrs;
        var sLifnr = this._oReconModel.getProperty("/mdLifnr");
        var sFromDate = this._sKeyDate;
        var sToDate = this._sKeyDateTo || this._sKeyDate;

        if (!sBukrs || !sLifnr || !sFromDate) {
          MessageToast.show(
            "Company Code, Supplier and From Date are required.",
          );
          return;
        }

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

        oReconModel.setProperty("/mdShowPayments", false);
        oReconModel.setProperty("/mdShowTransactions", false);
        oReconModel.setProperty("/mdShowGenericModule", false);
        oReconModel.setProperty("/mdShowAdvance", false);
        oReconModel.setProperty("/mdShowDebitNotes", true);
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
       * Fired from the "Payments" row in the master-detail Finance (FI)
       * panel. Calls PmtSelPrdSet directly for the current Company Code /
       * Supplier / date range already loaded on the page (same
       * Bukrs/Lifnr/From-To Date as Opening balance/Transactions — no
       * separate date-range dialog), e.g.:
       *   PmtSelPrdSet?$filter=Budat ge datetime'...' and Budat le
       *   datetime'...' and Bukrs eq '1000' and Lifnr eq '6000020'
       * Sums Dmbtr (Shkzg 'H' = credit, subtracted) into the Payments
       * total and switches the right panel into the Payments panel.
       */
      onPaymentsRowPress: function () {
        this._sActiveMdPanel = "payments";
        var sBukrs = this._sBukrs;
        var sLifnr = this._oReconModel.getProperty("/mdLifnr");
        var sFromDate = this._sKeyDate;
        var sToDate = this._sKeyDateTo || this._sKeyDate;

        if (!sBukrs || !sLifnr || !sFromDate) {
          MessageToast.show(
            "Company Code, Supplier and From Date are required.",
          );
          return;
        }

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
            // match the date range — treat that specific case as "no
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
       * as "yyyy-MM-ddT00:00:00" — no milliseconds, no "Z"/offset —
       * regardless of the browser's local timezone.
       */
      _toUtcMidnight: function (sYyyyMmDd) {
        var aParts = sYyyyMmDd.split("-").map(Number);
        return new Date(Date.UTC(aParts[0], aParts[1] - 1, aParts[2]));
      },

      /**
       * Maps a PmtSelPrdSet response into the shape the Payments table
       * binds to. Blart is constant ("KZ") across every row here, so
       * Pmttype ("ON_ACCOUNT" / "CLEARED") is carried through instead —
       * that's the field that actually distinguishes rows in this
       * response — sums the signed total, and switches the master-detail
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
        oReconModel.setProperty("/mdShowPayments", true);
        oReconModel.setProperty("/mdShowTransactions", false);
        oReconModel.setProperty("/mdShowGenericModule", false);
        oReconModel.setProperty("/mdShowAdvance", false);
        oReconModel.setProperty("/mdShowDebitNotes", false);
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
        if (sType.indexOf("partial") !== -1) return "partial";
        if (sType.indexOf("open") !== -1) return "open";
        // "Normal"/"NORMAL"/blank/anything else not matched above.
        return "normal";
      },

      /**
       * Groups the already-categorized Payments items (see
       * _categorizePmttype/PmtCategory) into exactly three fixed
       * categories — Normal, Open item, Partial payment — always
       * returned in that order (0 when a category has no rows) so the
       * bar chart in the stat-tiles row is always three bars, not a
       * variable-length list. Sums each group's already-signed NetAmt.
       */
      _computePaymentsTypeTotals: function (aItems) {
        var aCategories = [
          { key: "normal", label: "Normal", amount: 0 },
          { key: "open", label: "Open item", amount: 0 },
          { key: "partial", label: "Partial payment", amount: 0 },
        ];
        var oByKey = {
          normal: aCategories[0],
          open: aCategories[1],
          partial: aCategories[2],
        };

        (aItems || []).forEach(function (o) {
          oByKey[o.PmtCategory].amount += o.NetAmt;
        });

        return aCategories;
      },

      /**
       * Fired when a bar in the Payments-by-type chart is clicked.
       * Filters /paymentsItems (bound to the Payments table) down to the
       * items in that category — same toggle-to-clear behaviour as the
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
        } else {
          var aFiltered = aAll.filter(function (o) {
            return o.PmtCategory === sCategoryKey;
          });
          oReconModel.setProperty("/mdPaymentsSelectedCategory", sCategoryKey);
          oReconModel.setProperty("/paymentsItems", aFiltered);
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
    });
  },
);
