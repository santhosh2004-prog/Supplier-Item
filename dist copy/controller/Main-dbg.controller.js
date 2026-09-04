sap.ui.define(
  [
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageToast",
    "sap/ui/core/Fragment",
  ],
  function (
    Controller,
    Filter,
    FilterOperator,
    JSONModel,
    MessageToast,
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
      },

      /**
       * Fired from the back button on the master-detail (Supplier) panel.
       * Clears the Supplier field and re-runs the search, which drops the
       * page back into the Chart view for the current Company Code/dates.
       */
      onBackToChart: function () {
        this.byId("inputLifnr").setValue("");
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
                Blart: o.Blart,
                NetAmt: fSignedAmt,
                Augbl: o.Augdt,
              };
            });

            oReconModel.setProperty("/openItems", aItems);
            oReconModel.setProperty("/openingBalanceValue", fBalance);
            oReconModel.setProperty("/openItemsBusy", false);
          },
          error: function () {
            oReconModel.setProperty("/openItemsBusy", false);
            MessageToast.show("Error loading opening balance.");
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
          paymentsItems: [],
          paymentsTotal: 0,
          mdPaymentsPeriodLabel: "",
          openingBalanceValue: 0,
          openItemsTotal: 0,
        });

        var aFilters = [
          new Filter("Bukrs", FilterOperator.EQ, sBukrs),
          new Filter("Lifnr", FilterOperator.EQ, sLifnr),
          new Filter("Budat", FilterOperator.EQ, new Date(sKeyDate)),
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
                Blart: o.Blart,
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
          error: function () {
            oReconModel.setProperty("/mdSupplierName", "");
            oReconModel.setProperty("/openingBalanceValue", 0);
            oReconModel.setProperty("/openItemsBusy", false);
            oReconModel.setProperty("/busy", false);
            MessageToast.show("Error loading opening balance.");
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
        var oCtx = oEvent.getSource().getBindingContext("recon");
        if (!oCtx) return;
        var sLifnr = oCtx.getProperty("Lifnr");
        if (!sLifnr || !this._sBukrs || !this._sKeyDate) return;

        this.byId("inputLifnr").setValue(sLifnr);
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
          // result instead of the fixed 6-month Opening balance window.
          var aTransactionsAll = oReconModel.getProperty("/transactionsAll") || [];
          aMonthly = this._computeMonthsRangeTotals(
            aTransactionsAll,
            this._sKeyDate,
            this._sKeyDateTo || this._sKeyDate,
          );
        } else {
          var aOpenItemsAll = oReconModel.getProperty("/openItemsAll") || [];

          // Always exactly 6 fixed calendar months, ending at the searched
          // "From Date" — e.g. From Date = 28.02.2025 draws Sep 2024 through
          // Feb 2025. Months with no postings still get their own bar (a
          // flat/zero one) instead of being skipped, so the chart is always
          // a consistent 6-month strip.
          aMonthly = this._computeLastSixMonthsTotals(
            aOpenItemsAll,
            this._sKeyDate,
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
      _computeLastSixMonthsTotals: function (aOpenItems, sAnchorDate) {
        var oAnchor = sAnchorDate ? new Date(sAnchorDate) : new Date();
        if (isNaN(oAnchor.getTime())) {
          oAnchor = new Date();
        }
        var iAnchorKey = oAnchor.getFullYear() * 12 + oAnchor.getMonth();

        var oBuckets = {};
        for (var i = 5; i >= 0; i--) {
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
          if (!oBucket) return; // outside the fixed 6-month window
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
       * searched — unlike the Opening balance chart's fixed 6-month
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

        var aFilters = [
          new Filter("Bukrs", FilterOperator.EQ, sBukrs),
          new Filter("Lifnr", FilterOperator.EQ, sLifnr),
          new Filter("FromDate", FilterOperator.EQ, new Date(sFromDate)),
          new Filter("ToDate", FilterOperator.EQ, new Date(sToDate)),
        ];

        oReconModel.setProperty("/mdShowPayments", false);
        oReconModel.setProperty("/mdShowTransactions", true);
        oReconModel.setProperty("/mdShowGenericModule", false);
        oReconModel.setProperty("/mdShowAdvance", false);
        oReconModel.setProperty("/mdShowDebitNotes", false);
        oReconModel.setProperty("/mdSelectedMonthLabel", "");

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
                Blart: o.Blart,
                NetAmt: fSignedAmt,
                Augbl: o.Augdt,
              };
            });

            that._sortByBudatDesc(aItems);
            oReconModel.setProperty("/transactionItems", aItems);
            oReconModel.setProperty("/transactionsAll", aItems);
            oReconModel.setProperty("/transactionsTotal", that._sumNetAmt(aItems));
            that._renderMonthlyBarChart(0);
          },
          error: function (oError) {
            console.log("transactionperiodSet read failed:", oError);
            oReconModel.setProperty("/transactionItems", []);
            oReconModel.setProperty("/transactionsAll", []);
            oReconModel.setProperty("/transactionsTotal", 0);
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
                Blart: o.Blart,
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
                Blart: o.Blart,
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
        var oReconModel = this._oReconModel;

        this._sortByBudatDesc(aResults);
        var aItems = aResults.map(function (o) {
          var fDmbtr = parseFloat(o.Dmbtr) || 0;
          var fSignedAmt = o.Shkzg === "H" ? -fDmbtr : fDmbtr;
          return {
            Belnr: o.Belnr,
            Budat: o.Budat,
            Blart: o.Pmttype || o.Blart,
            NetAmt: fSignedAmt,
            Augbl: o.Augbl,
          };
        });
        var fTotal = aItems.reduce(function (fSum, o) {
          return fSum + o.NetAmt;
        }, 0);

        oReconModel.setProperty("/paymentsItems", aItems);
        oReconModel.setProperty("/paymentsTotal", fTotal);
        oReconModel.setProperty("/mdPaymentsPeriodLabel", sPeriodLabel);
        oReconModel.setProperty("/mdPaymentsValue", this.formatBalanceValue(fTotal));
        oReconModel.setProperty("/mdShowPayments", true);
        oReconModel.setProperty("/mdShowTransactions", false);
        oReconModel.setProperty("/mdShowGenericModule", false);
        oReconModel.setProperty("/mdShowAdvance", false);
        oReconModel.setProperty("/mdShowDebitNotes", false);
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
